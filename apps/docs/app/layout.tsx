import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { Hedvig_Letters_Serif, JetBrains_Mono } from 'next/font/google'
import type { ReactNode } from 'react'
import { ThemeProvider } from '@/components/theme-provider'
import './globals.css'

// Same faces as SAAS_BOILER's RootDocument: GT Standard on the body, JetBrains
// Mono and Hedvig Letters Serif as variables the tokens reference.
const gtStandard = localFont({
  src: [
    { path: '../fonts/GT-Standard-L-Standard-Light-Trial.woff2', weight: '300', style: 'normal' },
    { path: '../fonts/GT-Standard-L-Standard-Regular-Trial.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/GT-Standard-L-Standard-Medium-Trial.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/GT-Standard-L-Standard-Semibold-Trial.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/GT-Standard-L-Standard-Bold-Trial.woff2', weight: '700', style: 'normal' },
    { path: '../fonts/GT-Standard-L-Standard-Heavy-Trial.woff2', weight: '800', style: 'normal' },
    { path: '../fonts/GT-Standard-L-Standard-Black-Trial.woff2', weight: '900', style: 'normal' },
  ],
  variable: '--font-gt',
})
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400', '500'] })
const hedvigLettersSerif = Hedvig_Letters_Serif({ subsets: ['latin'], variable: '--font-serif', weight: '400' })

export const metadata: Metadata = {
  title: 'Design System',
  description: 'Component docs for @aspiralabs/ui, rendered from the MDX that ships in the package.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Sharp:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
      </head>
      <body className={`${gtStandard.className} ${jetbrainsMono.variable} ${hedvigLettersSerif.variable} antialiased`}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
