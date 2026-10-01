import express from 'express'
import apiRouter from './routes/index.js'

const app = express()
app.use(express.json())
app.use('/api', apiRouter)

const port = Number(process.env.PORT ?? 3000)
const server = app.listen(port, () => {
  console.log(`Price Tracker API listening on port ${port}`)
})

export { app, server }