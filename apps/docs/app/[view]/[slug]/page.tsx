import { notFound } from 'next/navigation'
import { compileMDX } from 'next-mdx-remote/rsc'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import { CopyMarkdown } from '@/components/copy-markdown'
import { mdxComponents } from '@/components/mdx'
import { getDoc, listDocs, VIEWS } from '@/lib/docs'

export function generateStaticParams() {
  return VIEWS.flatMap((v) => listDocs(v.id).map((d) => ({ view: v.id, slug: d.slug })))
}

export default async function DocPage({ params }: { params: Promise<{ view: string; slug: string }> }) {
  const { view, slug } = await params
  const meta = VIEWS.find((v) => v.id === view)
  if (!meta) {
    notFound()
  }
  const doc = getDoc(meta.id, slug)
  if (!doc) {
    notFound()
  }

  const { content } = await compileMDX({
    source: doc.body,
    components: mdxComponents,
    options: { mdxOptions: { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug] } },
  })

  return (
    <article>
      <header className="mb-10 flex items-start justify-between gap-6">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{doc.eyebrow}</p>
          <h1 className="text-4xl font-semibold tracking-tight">{doc.title}</h1>
          {doc.description && <p className="max-w-2xl text-lg text-foreground-subtext">{doc.description}</p>}
        </div>
        <CopyMarkdown raw={doc.raw} />
      </header>
      {content}
    </article>
  )
}
