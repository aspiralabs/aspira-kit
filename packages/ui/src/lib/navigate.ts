// The package does not depend on a router. Components that navigate take a
// `navigate` prop; when it is omitted this full-page fallback is used. In a
// Next.js app pass `useRouter().push`.
export type Navigate = (url: string) => void

export const defaultNavigate: Navigate = (url) => {
  if (typeof window !== 'undefined') {
    window.location.assign(url)
  }
}
