---
name: cpp
description: Implementing C++ code. Load this if you are going to write C++ code. Do not load this if you are merely reviewing C++ code, or planning changes to C++ code.
---

# C++ 

## Stay Modern

Always aim to use the latest language and standard library features available
in a given workspace. Just because something is the "tried and true" way does
not mean it is necessarily the most elegant solution.

## GoogleTest/GoogleMock

Make sure to set mock expectations before triggering expectations, to avoid
undefined behaviour stated in gmock's docs. For example:

```cpp
TEST(GravyTests, GravyIsYum)
{
    // Expectations must be set prior to exciting them. This includes using
    // loops.
    EXPECT_CALL(can, open);
    EXPECT_CALL(can, pour);
    EXPECT_CALL(bloke, eat);

    can.open();
    can.pour();
    bloke.eat();
}
```

## Doxygen

- Use triple slashes (`///`).
- Use `@` symbol for directives.

## Includes

Group and order includes like the following:

```cpp
// Local headers. Always use quotes.
#include "local/header.hpp"

// Headers from the same project/repo
#include <header/from/current/project.hpp>
#include <another/project_local/header.hpp>

// Headers from external dependencies
#include <third_party/header.hpp>
#include <another_third_party.hpp>

// Then standard library to finish
#include <vector>
```
