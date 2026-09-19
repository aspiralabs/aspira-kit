import { redirect } from 'next/navigation'
import { firstSlug } from '@/lib/docs'

export default function Home() {
  redirect(`/components/${firstSlug('components') ?? ''}`)
}
