// Flags Tailwind palette colors (bg-blue-500) and hex values in class strings.
// Colors come from tokens. This is rung 4 of the enforcement ladder: a review
// comment nobody has to write again.

const PALETTE = /(?:^|[\s:'"`])(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|placeholder|caret|accent|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?(?=$|[\s'"`])/
const HEX = /\[#(?:[0-9a-fA-F]{3,8})\]/

function check(context, node, value) {
  if (typeof value !== 'string') {
    return
  }
  const palette = value.match(PALETTE)
  if (palette) {
    context.report({ node, messageId: 'palette', data: { cls: palette[0].trim() } })
    return
  }
  if (HEX.test(value)) {
    context.report({ node, messageId: 'hex' })
  }
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow Tailwind palette colors and hex values; use design tokens.' },
    messages: {
      palette: 'Palette color "{{cls}}" is not a token. Use a semantic token class (bg-primary, text-muted-foreground, border-border).',
      hex: 'Hex color in a class string. Use a semantic token.',
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        check(context, node, node.value)
      },
      TemplateElement(node) {
        check(context, node, node.value.cooked)
      },
    }
  },
}
