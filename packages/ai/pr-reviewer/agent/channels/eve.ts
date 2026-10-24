import { eveChannel } from 'eve/channels/eve'
import { localDev, placeholderAuth, vercelOidc } from 'eve/channels/auth'

export default eveChannel({
  auth: [
    // Lets the eve TUI and Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // Not deployed yet. Replace before any deployment that accepts browser requests.
    placeholderAuth(),
  ],
})
