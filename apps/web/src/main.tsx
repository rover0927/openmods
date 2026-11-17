import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.js'
import './styles.css'
// MC 像素皮肤：覆盖令牌与组件选择器，必须在 styles.css 之后加载
import './mc-theme.css'
import { installUiSound } from './ui-sound.js'

// 点击音效：全局委托（用户首次点击即解锁媒体，无需额外交互）
installUiSound()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
