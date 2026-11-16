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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  render,
  screen,
  within,
  waitFor,
  cleanup,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Promotion } from '../index'

let client: QueryClient
const amounts = {
  recharge_quota: 1000000,
  redemption_quota: 500000,
  consumption_quota: 750000,
  pending_quota: 250000,
  unverified_orders: 0,
}
const snapshot = {
  total: 21,
  page: 1,
  page_size: 20,
  summary: amounts,
  items: [
    {
      id: 2,
      username: '<script>alert(1)</script>',
      deleted: false,
      ...amounts,
    },
  ],
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.getState().auth.setUser({ id: 1, username: 'owner', role: 1 })
  vi.spyOn(api, 'get').mockImplementation(async (url, config) => {
    if (url === '/api/user/aff') {
      return { data: { success: true, data: 'invite123' } }
    }
    if (url === '/api/user/promotion') {
      const params = config?.params as { page?: number } | undefined
      const page = params?.page ?? 1
      return {
        data: {
          success: true,
          data: {
            ...snapshot,
            page,
            items:
              page === 1
                ? snapshot.items
                : [{ id: 3, username: '', deleted: true, ...amounts }],
          },
        },
      }
    }
    return { data: { success: true, data: {} } }
  })
})
afterEach(() => {
  cleanup()
  client.clear()
  useAuthStore.getState().auth.reset()
  vi.restoreAllMocks()
})
function show() {
  render(
    <QueryClientProvider client={client}>
      <Promotion />
    </QueryClientProvider>
  )
}

test('shows direct invitees with separate amounts, escapes names and paginates', async () => {
  show()
  expect(
    await screen.findByRole('heading', { name: 'Promotion Center' })
  ).toBeInTheDocument()
  const table = await screen.findByRole('table')
  expect(within(table).queryAllByRole('button')).toHaveLength(0)
  expect(
    within(table).getByText('<script>alert(1)</script>')
  ).toBeInTheDocument()
  for (const name of [
    'Credited top-ups',
    'Redeemed credits',
    'Consumption excluding pending',
    'Pending charges',
  ]) {
    expect(
      within(table).getByRole('columnheader', { name })
    ).toBeInTheDocument()
  }
  expect(
    screen.getByRole('button', { name: 'Copy invitation link' })
  ).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: 'Go to next page' }))
  expect(await screen.findByText('Deleted account')).toBeInTheDocument()
  expect(
    screen.queryByText('<script>alert(1)</script>')
  ).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Go to next page' })).toBeDisabled()
})

test('shows an explicit empty state and disables pagination for no invitees', async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: { success: true, data: { ...snapshot, total: 0, items: [] } },
  })
  show()
  expect(await screen.findByText('No direct invitees yet')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Go to next page' })).toBeDisabled()
})

test('does not display stale amounts after a failed refresh and allows retry', async () => {
  show()
  await screen.findByRole('table')
  vi.mocked(api.get).mockRejectedValue(new Error('offline'))
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(
    await screen.findByText('Unable to load promotion statistics')
  ).toBeInTheDocument()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
})

test('does not carry another account statistics across an account switch', async () => {
  show()
  await screen.findByText('<script>alert(1)</script>')
  vi.mocked(api.get).mockImplementation(() => new Promise(() => {}))
  act(() => {
    useAuthStore
      .getState()
      .auth.setUser({ id: 8, username: 'another', role: 1 })
  })
  await waitFor(() => {
    expect(
      screen.queryByText('<script>alert(1)</script>')
    ).not.toBeInTheDocument()
  })
})

test('shows unknown consumption and excluded orders explicitly', async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: {
      success: true,
      data: {
        ...snapshot,
        summary: { ...amounts, consumption_quota: null, unverified_orders: 2 },
        items: [{ ...snapshot.items[0], consumption_quota: null }],
      },
    },
  })
  show()
  expect(
    await screen.findByText(
      'Some orders could not be verified and are excluded from credited top-ups: 2'
    )
  ).toBeInTheDocument()
  expect(await screen.findAllByText('Updating')).toHaveLength(2)
})
