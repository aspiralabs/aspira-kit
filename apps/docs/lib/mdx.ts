// Server side: compile a doc body to a function-body module string. The client
// evaluates it with the component scope (see components/doc-body.tsx). MDX
// export statements survive this path, which next-mdx-remote strips, and the
// docs use them for interactive demos.
import { compile } from '@mdx-js/mdx'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'

export async function compileDoc(body: string): Promise<string> {
  const file = await compile(body, {
    outputFormat: 'function-body',
    development: false,
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeSlug],
  })
  return String(file)
}
