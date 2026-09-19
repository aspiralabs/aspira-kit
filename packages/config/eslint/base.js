// The org's rung-4 rules. Every stack config spreads this first.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import unicorn from 'eslint-plugin-unicorn'
import noPaletteColors from './rules/no-palette-colors.js'

export const aspiralabs = {
  rules: { 'no-palette-colors': noPaletteColors },
}

export const orgRules = {
  // No ternaries in JSX. Use &&, an early return, or a lookup map.
  'no-restricted-syntax': [
    'error',
    {
      selector: 'JSXExpressionContainer > ConditionalExpression',
      message: 'No ternaries in JSX. Use &&, an early return, or a lookup map.',
    },
    {
      selector: 'JSXOpeningElement[name.name=/^(button|input|select|textarea|table)$/]',
      message: 'Raw form and table elements are not allowed. Use the component from @aspiralabs/ui.',
    },
  ],
  // Radix is wrapped by the ui package. Products never import it directly.
  'no-restricted-imports': [
    'error',
    { patterns: [{ group: ['@radix-ui/*'], message: 'Import the wrapped component from @aspiralabs/ui.' }] },
  ],
  'aspiralabs/no-palette-colors': 'error',
  'unicorn/filename-case': ['error', { case: 'kebabCase', ignore: [/^\[.*\]\.tsx?$/, /^_/] }],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
}

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { unicorn, aspiralabs },
    rules: orgRules,
  },
  {
    ignores: ['dist/**', '.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
)
