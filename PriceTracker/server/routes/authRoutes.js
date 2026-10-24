import { Router } from 'express'
import { postLogin, postSignup } from '../controllers/authController.js'

const router = Router()

router.post('/signup', postSignup)
router.post('/login', postLogin)

export default router
