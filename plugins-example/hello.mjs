// Copy to your plugin folder, set ENABLE_PLUGINS=true and PLUGIN_DIR. Runs with your permissions; every call still needs approval.
export default (z) => ({
  hello: {
    description: 'Return a greeting for {name}.',
    schema: z.object({ name: z.string().min(1).max(100) }).strict(),
    run: async ({ name }) => ({ greeting: `Hello, ${name}!` })
  }
});
