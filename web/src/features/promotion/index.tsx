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
import { useQuery } from '@tanstack/react-query'
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { DataTablePagination, DataTableView } from '@/components/data-table'
import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getAffiliateCode } from '@/features/wallet/api'
import { generateAffiliateLink } from '@/features/wallet/lib/affiliate'
import { toIntlLocale } from '@/i18n/languages'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import {
  getPromotion,
  type PromotionInvitee,
  type PromotionSnapshot,
} from './api'

export function Promotion() {
  const { t } = useTranslation()
  const userID = useAuthStore((state) => state.auth.user?.id)
  // Reset pagination when the authenticated identity changes. No cross-user
  // placeholder data or stale invitation link is ever rendered.
  return (
    <PromotionPage key={userID} userID={userID} title={t('Promotion Center')} />
  )
}

function PromotionPage(props: { userID?: number; title: string }) {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const statistics = useQuery({
    queryKey: ['nexora-promotion', props.userID, pagination],
    queryFn: ({ signal }) =>
      getPromotion(pagination.pageIndex + 1, pagination.pageSize, signal),
    enabled: Boolean(props.userID),
    staleTime: 30_000,
    gcTime: 0,
  })
  const invitation = useQuery({
    queryKey: ['nexora-promotion-link', props.userID],
    queryFn: async () => requireServerSuccess(await getAffiliateCode()).data,
    enabled: Boolean(props.userID),
    staleTime: 60_000,
    gcTime: 0,
  })
  const link =
    typeof invitation.data === 'string'
      ? generateAffiliateLink(invitation.data)
      : ''
  let report = <LoadingState />
  if (statistics.isError) {
    report = (
      <ErrorState
        title={t('Unable to load promotion statistics')}
        onRetry={() => {
          void statistics.refetch()
        }}
      />
    )
  } else if (statistics.data) {
    report = (
      <PromotionReport
        data={statistics.data}
        pagination={pagination}
        onPaginationChange={setPagination}
      />
    )
  }
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{props.title}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          disabled={statistics.isFetching}
          onClick={() => {
            void statistics.refetch()
            void invitation.refetch()
          }}
        >
          {t('Refresh')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='space-y-5 p-3 sm:p-4'>
          <p className='text-muted-foreground text-sm'>
            {t('All-time statistics for your direct invitees')}
          </p>
          <Card>
            <CardContent className='space-y-2 pt-5'>
              <Label htmlFor='promotion-invitation-link'>
                {t('Invitation link')}
              </Label>
              <div className='flex min-w-0 items-center gap-2'>
                <Input id='promotion-invitation-link' value={link} readOnly />
                {link && !invitation.isError && (
                  <CopyButton
                    value={link}
                    variant='outline'
                    aria-label={t('Copy invitation link')}
                  />
                )}
              </div>
              {invitation.isError && (
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => {
                    void invitation.refetch()
                  }}
                >
                  {t('Retry invitation link')}
                </Button>
              )}
            </CardContent>
          </Card>
          {report}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

function PromotionReport(props: {
  data: PromotionSnapshot
  pagination: PaginationState
  onPaginationChange: React.Dispatch<React.SetStateAction<PaginationState>>
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const columns = useMemo<ColumnDef<PromotionInvitee>[]>(
    () => [
      {
        accessorKey: 'username',
        header: t('Username'),
        cell: ({ row }) => (
          <span className='inline-block max-w-64 break-all'>
            {row.original.deleted
              ? t('Deleted account')
              : row.original.username}
          </span>
        ),
      },
      {
        accessorKey: 'recharge_quota',
        header: t('Credited top-ups'),
        cell: ({ row }) => formatQuotaWithCurrency(row.original.recharge_quota),
      },
      {
        accessorKey: 'redemption_quota',
        header: t('Redeemed credits'),
        cell: ({ row }) =>
          formatQuotaWithCurrency(row.original.redemption_quota),
      },
      {
        accessorKey: 'consumption_quota',
        header: t('Consumption excluding pending'),
        cell: ({ row }) =>
          row.original.consumption_quota === null
            ? t('Updating')
            : formatQuotaWithCurrency(row.original.consumption_quota),
      },
      {
        accessorKey: 'pending_quota',
        header: t('Pending charges'),
        cell: ({ row }) => formatQuotaWithCurrency(row.original.pending_quota),
      },
    ],
    [t]
  )
  const table = useReactTable({
    data: props.data.items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    enableSorting: false,
    enableHiding: false,
    rowCount: props.data.total,
    state: { pagination: props.pagination },
    onPaginationChange: props.onPaginationChange,
    getRowId: (row) => String(row.id),
  })
  const summary = props.data.summary
  const metrics = [
    {
      label: t('Direct invitees'),
      value: formatNumber(props.data.total, locale),
    },
    {
      label: t('Credited top-ups'),
      value: formatQuotaWithCurrency(summary.recharge_quota),
    },
    {
      label: t('Redeemed credits'),
      value: formatQuotaWithCurrency(summary.redemption_quota),
    },
    {
      label: t('Consumption excluding pending'),
      value:
        summary.consumption_quota === null
          ? t('Updating')
          : formatQuotaWithCurrency(summary.consumption_quota),
    },
    {
      label: t('Pending charges'),
      value: formatQuotaWithCurrency(summary.pending_quota),
    },
  ]
  return (
    <div className='space-y-4'>
      <dl className='grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5'>
        {metrics.map((metric) => (
          <Card key={metric.label}>
            <CardContent className='pt-5'>
              <dt className='text-muted-foreground text-sm'>{metric.label}</dt>
              <dd className='mt-2 text-2xl font-semibold break-all tabular-nums'>
                {metric.value}
              </dd>
            </CardContent>
          </Card>
        ))}
      </dl>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Top-ups show credited quota from retained successful orders, not cash paid. Redeemed codes are separate; gifts and direct balance edits are excluded.'
        )}
      </p>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Consumption subtracts outstanding task charges from the official cumulative usage. Settlement and refunds may take time to appear; these statistics are not a settlement ledger.'
        )}
      </p>
      {summary.unverified_orders > 0 && (
        <p role='status' className='text-sm font-medium'>
          {t(
            'Some orders could not be verified and are excluded from credited top-ups: {{count}}',
            { count: summary.unverified_orders }
          )}
        </p>
      )}
      <DataTableView
        table={table}
        emptyTitle={t('No direct invitees yet')}
        tableContainerClassName='overflow-x-auto'
        tableClassName='min-w-[720px]'
        containerProps={{ 'aria-label': t('Direct invitees') }}
      />
      <DataTablePagination table={table} compact />
    </div>
  )
}
