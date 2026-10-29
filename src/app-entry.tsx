import React from 'react'
import { createRoot } from 'react-dom/client'
import { ErpApp } from './erp/ErpApp'

export function mount(container: HTMLElement) {
  container.replaceChildren()
  createRoot(container).render(<React.StrictMode><ErpApp /></React.StrictMode>)
}
