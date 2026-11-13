// Command files are bundled as text (esbuild's text loader).
declare module "*.md" {
  const text: string;
  export default text;
}
