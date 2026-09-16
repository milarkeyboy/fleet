-- List of programming languages, with required tooling info:
--   * 'ts' for tresitter targets.
--   * 'lsp' for language server protocol provider to enable.
return {
  {
    ts = {"c", "cpp"},
    lsp = "clangd",
  },

  {
    ts = "rust",
    lsp = "rust_analyzer",
  },

  {
    ts = { "typescript", "tsx", "javascript", "jsdoc" },
    lsp = "ts_ls",
  },

  {
    ts = "python",
    lsp = "pyright",
  },

  {
    ts = { "markdown", "markdown_inline" },
    lsp = "marksman",
  },

  {
    ts = "lua",
    lsp = "lua_ls",
  },

  {
    ts = "meson",
    lsp = "mesonlsp",
  },

  {
    ts = "nix",
    lsp = "nixd",
  },
}

