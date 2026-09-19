// Next.js products: Next's own rules plus the org rules.
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import base from './base.js'

export default [...nextVitals, ...nextTs, ...base]
