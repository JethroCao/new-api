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
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { LanguageSwitcher } from '@/components/language-switcher'
import { ThemeSwitch } from '@/components/theme-switch'
import { Skeleton } from '@/components/ui/skeleton'
import { useSystemConfig } from '@/hooks/use-system-config'

type AuthLayoutProps = {
  children: React.ReactNode
  variant?: 'default' | 'split'
}

export function AuthLayout({ children, variant = 'default' }: AuthLayoutProps) {
  const { t } = useTranslation()
  const { systemName, logo, loading } = useSystemConfig()

  if (variant === 'split') {
    return (
      <div className='nexora-sign-in'>
        <header className='nexora-sign-in-header'>
          <Link to='/' className='nexora-sign-in-brand'>
            {loading ? (
              <Skeleton className='size-10 rounded-lg' />
            ) : (
              <img src={logo} alt='' className='size-10 object-contain' />
            )}
            {loading ? <Skeleton className='h-7 w-28' /> : systemName}
          </Link>
          <div className='flex items-center gap-1'>
            <LanguageSwitcher />
            <ThemeSwitch />
          </div>
        </header>

        <main className='nexora-sign-in-main'>
          <section
            className='nexora-sign-in-story'
            aria-labelledby='sign-in-story-title'
          >
            <p className='nexora-sign-in-eyebrow'>AI · API · POSSIBILITY</p>
            <h1 id='sign-in-story-title'>
              {t('Your ideas,')}
              <br />
              <span>{t('connected to possibility.')}</span>
            </h1>
            <p className='nexora-sign-in-description'>
              {t(
                'Connect AI models through one platform. Turn your next idea into an application.'
              )}
            </p>

            <div className='nexora-sign-in-visual' aria-hidden='true'>
              <div className='nexora-sign-in-orbit' />
              <div className='nexora-sign-in-orbit nexora-sign-in-orbit-inner' />
              <div className='nexora-sign-in-core'>
                {!loading && <img src={logo} alt='' />}
              </div>
              <div className='nexora-sign-in-node nexora-sign-in-node-chat'>
                <span>&lt;/&gt;</span> Chat API
              </div>
              <div className='nexora-sign-in-node nexora-sign-in-node-video'>
                <span>▷</span> Video API
              </div>
              <div className='nexora-sign-in-code'>
                <span>POST</span> /v1/videos
              </div>
            </div>

            <div className='nexora-sign-in-benefits'>
              <span>{t('Unified access')}</span>
              <span>{t('Usage visibility')}</span>
              <span>{t('Built for developers')}</span>
            </div>
          </section>

          <section className='nexora-sign-in-panel' aria-label={t('Sign in')}>
            <div className='nexora-sign-in-form'>{children}</div>
            <Link to='/' className='nexora-sign-in-home'>
              <span aria-hidden='true'>←</span> {t('Back to Home')}
            </Link>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className='relative grid h-svh max-w-none'>
      <Link
        to='/'
        className='absolute top-4 left-4 z-10 flex items-center gap-2 transition-opacity hover:opacity-80 sm:top-8 sm:left-8'
      >
        <div className='relative h-8 w-8'>
          {loading ? (
            <Skeleton className='absolute inset-0 rounded-full' />
          ) : (
            <img
              src={logo}
              alt={t('Logo')}
              className='h-8 w-8 rounded-full object-cover'
            />
          )}
        </div>
        {loading ? (
          <Skeleton className='h-6 w-24' />
        ) : (
          <h1 className='text-xl font-medium'>{systemName}</h1>
        )}
      </Link>
      <div className='container flex items-center pt-16 sm:pt-0'>
        <div className='mx-auto flex w-full flex-col justify-center space-y-2 px-4 py-8 sm:w-[480px] sm:p-8'>
          {children}
        </div>
      </div>
    </div>
  )
}
