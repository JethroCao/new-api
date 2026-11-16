/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

export type PromotionAmounts = {
  recharge_quota: number
  redemption_quota: number
  consumption_quota: number | null
  pending_quota: number
  unverified_orders: number
}

export type PromotionInvitee = PromotionAmounts & {
  id: number
  username: string
  deleted: boolean
}

export type PromotionSnapshot = {
  total: number
  page: number
  page_size: number
  summary: PromotionAmounts
  items: PromotionInvitee[]
}

export async function getPromotion(
  page: number,
  pageSize: number,
  signal?: AbortSignal
): Promise<PromotionSnapshot> {
  const response = await api.get('/api/user/promotion', {
    params: { page, page_size: pageSize },
    signal,
  })
  return requireServerSuccess(response.data).data
}
