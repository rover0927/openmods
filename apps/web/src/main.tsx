import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.js'
import './styles.css'
// MC 像素皮肤：覆盖令牌与组件选择器，必须在 styles.css 之后加载
import './mc-theme.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
