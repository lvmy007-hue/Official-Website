import './tailwind.css'
import React from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { PublicRoot } from './PublicRoot'

export function mount(container: HTMLElement, path: string) {
  const app = <React.StrictMode><PublicRoot initialPath={path} /></React.StrictMode>
  if (container.firstElementChild) hydrateRoot(container, app)
  else createRoot(container).render(app)
}
