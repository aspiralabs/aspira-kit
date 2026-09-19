import { redirect, notFound } from 'next/navigation'
import { firstSlug, VIEWS } from '@/lib/docs'

export default async function ViewIndex({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params
  const meta = VIEWS.find((v) => v.id === view)
  if (!meta) {
    notFound()
  }
  const slug = firstSlug(meta.id)
  if (slug) {
    redirect(`/${meta.id}/${slug}`)
  }
  return <p className="text-foreground-subtext">Nothing migrated into this section yet.</p>
}
