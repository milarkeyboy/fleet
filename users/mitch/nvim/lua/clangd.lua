-- Build directories are tried in order when a project does not configure clangd
-- explicitly. Add more names here as needed for local build conventions.
local clangd_build_directories = {
  "build",
  "builddir",
}

local function strip_yaml_comment(line)
  local quote
  local escaped = false

  for index = 1, #line do
    local character = line:sub(index, index)
    if quote == '"' then
      if escaped then
        escaped = false
      elseif character == "\\" then
        escaped = true
      elseif character == '"' then
        quote = nil
      end
    elseif quote == "'" then
      if character == "'" and line:sub(index + 1, index + 1) ~= "'" then
        quote = nil
      end
    elseif character == '"' or character == "'" then
      quote = character
    elseif character == '#' and (index == 1 or line:sub(index - 1, index - 1):match("%s")) then
      return line:sub(1, index - 1)
    end
  end

  return line
end

local function has_flow_compilation_database_key(line)
  local quote
  local escaped = false

  for index = 1, #line do
    local character = line:sub(index, index)
    if quote == '"' then
      if escaped then
        escaped = false
      elseif character == "\\" then
        escaped = true
      elseif character == '"' then
        quote = nil
      end
    elseif quote == "'" then
      if character == "'" and line:sub(index + 1, index + 1) ~= "'" then
        quote = nil
      end
    elseif character == '"' or character == "'" then
      quote = character
    elseif character == '{' or character == ',' then
      local remainder = line:sub(index + 1)
      if remainder:match("^%s*['\"]CompilationDatabase['\"]%s*:")
        or remainder:match("^%s*CompilationDatabase%s*:") then
        return true
      end
    end
  end

  return false
end

-- A key-looking string in a block scalar is data, not part of the document's
-- mapping. Track scalar indentation before looking for clangd's setting.
local function has_compilation_database_key(lines)
  local block_scalar_parent_indent

  for _, original_line in ipairs(lines) do
    local line = strip_yaml_comment(original_line)
    local indentation = #(line:match("^ *") or "")
    local content = line:sub(indentation + 1)
    local blank = content:match("^%s*$") ~= nil

    if block_scalar_parent_indent then
      if blank or indentation > block_scalar_parent_indent then
        goto continue
      end
      block_scalar_parent_indent = nil
    end

    if not blank then
      local block_key = content:match("^['\"]?CompilationDatabase['\"]?%s*:")
      if block_key or has_flow_compilation_database_key(content) then
        return true
      end

      if content:match(":%s*[|>][1-9]?[%+%-]?%s*$") then
        block_scalar_parent_indent = indentation
      end
    end

    ::continue::
  end

  return false
end

local function has_compilation_database_setting(root_dir)
  local clangd_file = vim.fs.joinpath(root_dir, ".clangd")
  if vim.fn.filereadable(clangd_file) == 0 then
    return false
  end
  return has_compilation_database_key(vim.fn.readfile(clangd_file))
end

local function clangd_before_init(_, config)
  local root_dir = config.root_dir
  if not root_dir or has_compilation_database_setting(root_dir) then
    return
  end

  for _, build_directory in ipairs(clangd_build_directories) do
    local directory = vim.fs.joinpath(root_dir, build_directory)
    local database = vim.fs.joinpath(directory, "compile_commands.json")
    if vim.fn.filereadable(database) == 1 then
      config.cmd = vim.deepcopy(config.cmd or { "clangd" })
      table.insert(config.cmd, "--compile-commands-dir=" .. directory)
      return
    end
  end
end

return {
  before_init = clangd_before_init,
  -- Kept public so the YAML edge cases can be tested without starting clangd.
  _has_compilation_database_key = has_compilation_database_key,
}
