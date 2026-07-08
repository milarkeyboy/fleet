-- Setup keymaps on LSP attach
local group = vim.api.nvim_create_augroup("my.lsp.keymaps", { clear = true })
vim.api.nvim_create_autocmd("LspAttach", {
  group = group,
  callback = function(event)
    local bufnr = event.buf
  
    local map = function(lhs, rhs, desc)
      vim.keymap.set("n", lhs, rhs, {
        buffer = bufnr,
        desc = desc,
      })
    end
  
    map("gd", vim.lsp.buf.definition, "Go to definition")
    map("gD", vim.lsp.buf.declaration, "Go to declaration")
    map("gr", vim.lsp.buf.references, "Find references")
    map("gi", vim.lsp.buf.implementation, "Go to implementation")
    map("K", vim.lsp.buf.hover, "Hover documentation")
    map("<leader>r", vim.lsp.buf.rename, "Rename symbol")
    map("<leader>c", vim.lsp.buf.code_action, "Code action")
  end,
})

-- Enable LSP for each language
for _, lang in ipairs(require('languages')) do
  vim.lsp.enable(lang.lsp)
end
