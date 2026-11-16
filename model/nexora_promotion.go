package model

import (
	"context"
	"errors"
	"math"

	"github.com/QuantumNous/new-api/common"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

// These are read models only. They are not registered with AutoMigrate.
// Amounts are quota units, not gateway cash paid or referral commissions.
type NexoraPromotionAmounts struct {
	RechargeQuota    int64  `json:"recharge_quota"`
	RedemptionQuota  int64  `json:"redemption_quota"`
	ConsumptionQuota *int64 `json:"consumption_quota"`
	PendingQuota     int64  `json:"pending_quota"`
	UnverifiedOrders int64  `json:"unverified_orders"`
}

type NexoraPromotionInvitee struct {
	ID       int    `json:"id"`
	Username string `json:"username"`
	Deleted  bool   `json:"deleted"`
	NexoraPromotionAmounts
}

type NexoraPromotion struct {
	Total    int                      `json:"total"`
	Page     int                      `json:"page"`
	PageSize int                      `json:"page_size"`
	Items    []NexoraPromotionInvitee `json:"items"`
	Summary  NexoraPromotionAmounts   `json:"summary"`
}

// GetNexoraPromotion scopes EVERY source to the authenticated inviter. There is
// no period filter: retained historical orders and redeemed (even soft-deleted)
// codes are included. No wallet, reward, registration or settlement is changed.
// Official used_quota and task counters are eventually consistent; a negative
// residual is unknown (null), never silently converted into zero consumption.
func GetNexoraPromotion(ctx context.Context, inviterID, page, pageSize int) (*NexoraPromotion, error) {
	if inviterID <= 0 || page < 1 || page > 1_000_000 || pageSize < 1 || pageSize > 100 {
		return nil, errors.New("invalid promotion query")
	}
	db := DB.WithContext(ctx)
	var users []struct {
		Id        int
		UsedQuota int64
	}
	if err := db.Unscoped().Model(&User{}).Select("id, used_quota").Where("inviter_id = ?", inviterID).Scan(&users).Error; err != nil {
		return nil, err
	}
	zero := int64(0)
	result := &NexoraPromotion{Total: len(users), Page: page, PageSize: pageSize, Items: []NexoraPromotionInvitee{}, Summary: NexoraPromotionAmounts{ConsumptionQuota: &zero}}
	if len(users) == 0 {
		return result, nil
	}
	amounts := make(map[int]*NexoraPromotionAmounts, len(users))
	for _, user := range users {
		used := user.UsedQuota
		amounts[user.Id] = &NexoraPromotionAmounts{ConsumptionQuota: &used}
	}
	invitedIDs := db.Unscoped().Model(&User{}).Select("id").Where("inviter_id = ?", inviterID)
	// Legacy Midjourney tasks keep their billing state in a separate table.
	// Positive reserves on failed tasks are still awaiting refund.
	for _, taskModel := range []any{&Task{}, &Midjourney{}} {
		var pending []struct {
			UserId int
			Quota  int64
		}
		if err := db.Model(taskModel).Select("user_id, SUM(quota) AS quota").Where("user_id IN (?)", invitedIDs).Where("(status IS NULL OR status <> ?) AND quota > 0", TaskStatusSuccess).Group("user_id").Scan(&pending).Error; err != nil {
			return nil, err
		}
		for _, item := range pending {
			if a := amounts[item.UserId]; a != nil {
				if err := addNexoraPromotionQuota(&a.PendingQuota, item.Quota); err != nil {
					return nil, err
				}
			}
		}
	}
	// Subscription purchases also create successful TopUp records but credit no
	// wallet quota. Use their persisted order relation, not the payment currency.
	subscriptionTrades := db.Model(&SubscriptionOrder{}).Select("trade_no").Where("user_id IN (?)", invitedIDs).Where("trade_no <> ?", "")
	rows, err := db.Model(&TopUp{}).Select("user_id, amount, money, payment_provider, payment_method").Where("user_id IN (?)", invitedIDs).Where("status = ?", common.TopUpStatusSuccess).Where("trade_no NOT IN (?)", subscriptionTrades).Rows()
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var order TopUp
		if err = db.ScanRows(rows, &order); err != nil {
			break
		}
		a := amounts[order.UserId]
		if a == nil {
			continue
		}
		quota, ok := nexoraPromotionOrderQuota(order)
		if !ok {
			a.UnverifiedOrders++
			continue
		}
		if err = addNexoraPromotionQuota(&a.RechargeQuota, quota); err != nil {
			break
		}
	}
	rowErr := rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return nil, err
	}
	if rowErr != nil {
		return nil, rowErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	var codes []struct {
		UsedUserId int
		Quota      int64
	}
	if err = db.Unscoped().Model(&Redemption{}).Select("used_user_id, SUM(quota) AS quota").Where("used_user_id IN (?)", invitedIDs).Where("status = ?", common.RedemptionCodeStatusUsed).Group("used_user_id").Scan(&codes).Error; err != nil {
		return nil, err
	}
	for _, item := range codes {
		if a := amounts[item.UsedUserId]; a != nil {
			a.RedemptionQuota = item.Quota
		}
	}
	for _, a := range amounts {
		if *a.ConsumptionQuota < a.PendingQuota {
			a.ConsumptionQuota = nil
		} else {
			*a.ConsumptionQuota -= a.PendingQuota
		}
		for _, field := range []struct {
			target *int64
			value  int64
		}{{&result.Summary.RechargeQuota, a.RechargeQuota}, {&result.Summary.RedemptionQuota, a.RedemptionQuota}, {&result.Summary.PendingQuota, a.PendingQuota}, {&result.Summary.UnverifiedOrders, a.UnverifiedOrders}} {
			if err = addNexoraPromotionQuota(field.target, field.value); err != nil {
				return nil, err
			}
		}
		if a.ConsumptionQuota == nil {
			result.Summary.ConsumptionQuota = nil
		} else if result.Summary.ConsumptionQuota != nil {
			if err = addNexoraPromotionQuota(result.Summary.ConsumptionQuota, *a.ConsumptionQuota); err != nil {
				return nil, err
			}
		}
	}
	var selected []struct {
		Id        int
		Username  string
		DeletedAt gorm.DeletedAt
	}
	if err = db.Unscoped().Model(&User{}).Select("id, username, deleted_at").Where("inviter_id = ?", inviterID).Order("id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Scan(&selected).Error; err != nil {
		return nil, err
	}
	for _, user := range selected {
		a := amounts[user.Id]
		if a == nil {
			continue
		} // concurrent registration appears on refresh
		if user.DeletedAt.Valid {
			user.Username = ""
		}
		result.Items = append(result.Items, NexoraPromotionInvitee{ID: user.Id, Username: user.Username, Deleted: user.DeletedAt.Valid, NexoraPromotionAmounts: *a})
	}
	return result, nil
}

// Provider fields have different meanings in the official top-up records.
// Mirror normal successful-credit conversions; do not sum Money across currencies.
// Empty provider is the historical epay representation. Unrecognized providers
// or invalid amounts stay explicitly unverified rather than being guessed.
func nexoraPromotionOrderQuota(order TopUp) (int64, bool) {
	if order.Amount <= 0 {
		return 0, false
	}
	provider := order.PaymentProvider
	if provider == "" {
		switch order.PaymentMethod {
		case PaymentMethodStripe, PaymentMethodCreem, PaymentMethodWaffo, PaymentMethodWaffoPancake:
			provider = order.PaymentMethod
		case "alipay", "wxpay", "", "paypal":
			provider = PaymentProviderEpay
		default:
			return 0, false
		}
	}
	var quota decimal.Decimal
	switch provider {
	case PaymentProviderStripe:
		if math.IsNaN(order.Money) || math.IsInf(order.Money, 0) || order.Money <= 0 {
			return 0, false
		}
		quota = decimal.NewFromFloat(order.Money).Mul(decimal.NewFromFloat(common.QuotaPerUnit))
	case PaymentProviderCreem:
		// RechargeCreem credits Amount; ManualCompleteTopUp credits Amount *
		// QuotaPerUnit without persisting which path was taken. The historical
		// row cannot prove credited quota, so never guess between those values.
		return 0, false
	case PaymentProviderEpay, PaymentProviderWaffo, PaymentProviderWaffoPancake:
		quota = decimal.NewFromInt(order.Amount).Mul(decimal.NewFromFloat(common.QuotaPerUnit))
	default:
		return 0, false
	}
	value, err := common.WalletQuotaFromDecimalStrict(quota)
	return int64(value), err == nil && value > 0
}

func addNexoraPromotionQuota(total *int64, value int64) error {
	if value < 0 || value > int64(common.MaxWalletQuota)-*total {
		return errors.New("promotion quota aggregate is outside the supported range")
	}
	*total += value
	return nil
}
