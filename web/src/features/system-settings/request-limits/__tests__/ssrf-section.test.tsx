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
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { SSRFSection } from '../ssrf-section'

function Fixture() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <SSRFSection
          defaultValues={{
            'fetch_setting.enable_ssrf_protection': true,
            'fetch_setting.allow_private_ip': false,
            'fetch_setting.domain_filter_mode': false,
            'fetch_setting.ip_filter_mode': false,
            'fetch_setting.domain_list': [],
            'fetch_setting.ip_list': [],
            'fetch_setting.allowed_ports': [],
            'fetch_setting.apply_ip_filter_for_domain': true,
          }}
        />
      </SettingsPageProvider>
    </>
  )
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

test.each([
  ['8787', '["8787"]'],
  [' 80, 443, 8000-9000 ', '["80","443","8000-9000"]'],
])(
  'saving allowed ports %s preserves the backend string-array contract',
  async (input, expected) => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    const router = createRouter({
      routeTree: createRootRoute({ component: Fixture }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )
    const field = await screen.findByRole('textbox', { name: 'Allowed Ports' })
    fireEvent.change(field, { target: { value: input } })
    fireEvent.click(screen.getByRole('button', { name: 'Save SSRF settings' }))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/api/option/', {
        key: 'fetch_setting.allowed_ports',
        value: expected,
      })
    )
  }
)
