-- Clangd-specific setup lives in its own module rather than this common LSP wiring.

vim.lsp.config("clangd", {
  cmd = { "clangd", "--fallback-style=none" },
  before_init = require("clangd").before_init,
})

-- Format synchronously before saving so the file includes the LSP's edits.
local format_group = vim.api.nvim_create_augroup("my.lsp.format", { clear = true })
vim.api.nvim_create_autocmd("BufWritePre", {
  group = format_group,
  callback = function(event)
    local clients = vim.lsp.get_clients({
      bufnr = event.buf,
      method = "textDocument/formatting",
    })
    if #clients > 0 then
      vim.lsp.buf.format({ bufnr = event.buf, async = false })
    end
  end,
})

-- Enable LSP for each language
for _, lang in ipairs(require('languages')) do
  vim.lsp.enable(lang.lsp)
end
