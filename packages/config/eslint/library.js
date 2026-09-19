// For @aspiralabs/ui itself. The org rules apply, except the ui package is the
// one place raw elements and Radix imports are allowed: that is where they get wrapped.
import base from './base.js'

export default [
  ...base,
  {
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXExpressionContainer > ConditionalExpression',
          message: 'No ternaries in JSX. Use &&, an early return, or a lookup map.',
        },
      ],
    },
  },
]
