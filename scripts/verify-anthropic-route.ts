import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import anthropicRouter from '../src/main/proxy/routes/anthropic'
import { storeManager } from '../src/main/store/store'
import { loadBalancer } from '../src/main/proxy/loadbalancer'
import { modelMapper } from '../src/main/proxy/modelMapper'

async function run(): Promise<void> {
  ;(storeManager as any).getConfig = () => ({
    loadBalanceStrategy: 'round_robin',
  })
  ;(loadBalancer as any).selectAccount = () => null
  ;(modelMapper as any).getPreferredProvider = () => undefined
  ;(modelMapper as any).getPreferredAccount = () => undefined

  const app = new Koa()
  app.use(bodyParser())
  app.use(anthropicRouter.routes())
  app.use(anthropicRouter.allowedMethods())
  app.use((ctx) => {
    ctx.status = 404
    ctx.body = {
      error: {
        message: `Route not found: ${ctx.method} ${ctx.path}`,
      },
    }
  })

  const server = app.listen(18091, '127.0.0.1')

  try {
    const validRes = await fetch('http://127.0.0.1:18091/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    const validText = await validRes.text()
    const validBody = (() => {
      try {
        return JSON.parse(validText)
      } catch {
        return validText
      }
    })()

    const invalidRes = await fetch('http://127.0.0.1:18091/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
      }),
    })
    const invalidText = await invalidRes.text()
    const invalidBody = (() => {
      try {
        return JSON.parse(invalidText)
      } catch {
        return invalidText
      }
    })()

    console.log(
      JSON.stringify(
        {
          validRequest: {
            status: validRes.status,
            body: validBody,
          },
          invalidRequest: {
            status: invalidRes.status,
            body: invalidBody,
          },
        },
        null,
        2
      )
    )
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
