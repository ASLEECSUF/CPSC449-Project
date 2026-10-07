import express from 'express'
import config from './config.js'
import apiRouter from './routes/index.js'

const app = express()
app.use(express.json())
app.use('/api', apiRouter)

const server = app.listen(config.port, () => {
  console.log(`Price Tracker API listening on port ${config.port}`)
})

export { app, server }
