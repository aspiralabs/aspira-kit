import { Button } from '@aspiralabs/ui'
import { listDocs, uiVersion } from '@/lib/docs'

export default function Home() {
  const docs = listDocs()
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 p-8">
      <header className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">@aspiralabs/ui {uiVersion()}</p>
        <h1 className="text-3xl font-semibold tracking-tight">Aspira Kit</h1>
        <p className="text-muted-foreground">
          Component docs rendered from the MDX that ships inside the package. The MCP server reads the same files.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Button, live from the package</h2>
        <div className="flex flex-wrap gap-3 rounded-lg border border-border p-6">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Components</h2>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {docs.map((doc) => (
            <li key={doc.name} className="flex flex-col gap-1 p-4">
              <span className="font-medium">{doc.title}</span>
              <span className="text-sm text-muted-foreground">{doc.description}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Next: port the SAAS_BOILER design-system renderer (contentlayer, Demo blocks, nav from frontmatter) so each doc renders in full.
        </p>
      </section>
    </main>
  )
}
