import { isWorkspacePath } from './route-kind'

const container = document.getElementById('root')!
const path = window.location.pathname || '/'

if (isWorkspacePath(path)) void import('./app-entry').then(entry => entry.mount(container))
else void import('./public-entry').then(entry => entry.mount(container, path))
