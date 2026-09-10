// Vite's `?raw` suffix imports a file's contents as a plain string, with no
// Node.js APIs or @types/node needed (the backend has no runtime npm deps).
declare module '*?raw' {
  const content: string;
  export default content;
}
