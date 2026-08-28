package.path = "users/mitch/nvim/lua/?.lua;" .. package.path

local clangd = require("clangd")
local has_database_key = clangd._has_compilation_database_key

assert(has_database_key({ "CompilationDatabase: build" }))
assert(has_database_key({ "Diagnostics: { CompilationDatabase: build }" }))
assert(not has_database_key({ "# CompilationDatabase: build", "Diagnostics: {} # CompilationDatabase: build" }))
assert(not has_database_key({ 'Description: "{ CompilationDatabase: example }"' }))
assert(not has_database_key({
  "Diagnostics:",
  "  Suppress: |",
  "    CompilationDatabase: example",
}))

local function make_project()
  local root = vim.fn.tempname()
  assert(vim.fn.mkdir(root, "p") == 1)
  return root
end

-- A generated database in the conventional build directory should be selected.
do
  local root = make_project()
  local build = vim.fs.joinpath(root, "build")
  assert(vim.fn.mkdir(build, "p") == 1)
  assert(vim.fn.writefile({ "{}" }, vim.fs.joinpath(build, "compile_commands.json")) == 0)

  local config = { root_dir = root, cmd = { "clangd" } }
  clangd.before_init(nil, config)
  assert(vim.deep_equal({ "clangd", "--compile-commands-dir=" .. build }, config.cmd))
  vim.fn.delete(root, "rf")
end

-- An explicit project setting must take precedence over the fallback.
do
  local root = make_project()
  local build = vim.fs.joinpath(root, "build")
  assert(vim.fn.mkdir(build, "p") == 1)
  assert(vim.fn.writefile({ "{}" }, vim.fs.joinpath(build, "compile_commands.json")) == 0)
  assert(vim.fn.writefile({ "CompilationDatabase: custom-build" }, vim.fs.joinpath(root, ".clangd")) == 0)

  local config = { root_dir = root, cmd = { "clangd" } }
  clangd.before_init(nil, config)
  assert(vim.deep_equal({ "clangd" }, config.cmd))
  vim.fn.delete(root, "rf")
end

-- Without a database, clangd's command should remain untouched.
do
  local root = make_project()
  local config = { root_dir = root, cmd = { "clangd" } }
  clangd.before_init(nil, config)
  assert(vim.deep_equal({ "clangd" }, config.cmd))
  vim.fn.delete(root, "rf")
end
