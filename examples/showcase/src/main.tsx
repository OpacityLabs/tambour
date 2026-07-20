import { createRoot } from 'react-dom/client'
import { connectDevtools } from 'tambour'
import App from './App'
import './styles.css'

// Everything is named, so devtools is just an interceptor forwarding to a UI.
connectDevtools({ name: 'tambour-showcase' })

// localStorage hydration is synchronous — no gate needed (MMKV-on-RN analog).
createRoot(document.getElementById('root')!).render(<App />)
