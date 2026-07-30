cmake_minimum_required(VERSION 3.15)
project(cppws LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# ── Source files ──────────────────────────────────────────────────────
set(SOURCES
    ${CMAKE_CURRENT_SOURCE_DIR}/src/cpp/binding.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/cpp/websocket_core.cpp
)

# ── node-addon-api ────────────────────────────────────────────────────
find_package(node-addon-api CONFIG QUIET)

if(NOT node-addon-api_FOUND)
    find_path(NAPI_INCLUDE_DIR
        NAMES napi.h
        PATHS
            ${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-addon-api
            ${CMAKE_CURRENT_SOURCE_DIR}/../node_modules/node-addon-api
        NO_DEFAULT_PATH
    )

    if(NAPI_INCLUDE_DIR)
        add_library(node-addon-api INTERFACE IMPORTED)
        target_include_directories(node-addon-api INTERFACE ${NAPI_INCLUDE_DIR})
        set(node-addon-api_FOUND TRUE)
    endif()
endif()

if(NOT node-addon-api_FOUND)
    message(FATAL_ERROR
        "node-addon-api not found. Install it with: npm install node-addon-api")
endif()

# ── uWebSockets (uSockets) ────────────────────────────────────────────
# Windows: uSockets ships a GNU-style Makefile (wildcard globs, gcc flags
# like -flto/-std=c11) that MSVC's nmake cannot parse — nmake isn't GNU
# Make, and cl.exe doesn't accept those flags. There is no working local
# build path for uSockets on MSVC. Use vcpkg's `usockets` port instead,
# which builds a proper MSVC-toolchain-compatible static lib.
# uWebSockets' own headers (App.h etc.) still come from our pinned local
# clone on every platform, so the API surface stays identical everywhere.
set(UWS_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/uWebSockets/src")

if(WIN32)
    find_package(unofficial-usockets CONFIG REQUIRED)
    if(NOT TARGET unofficial::usockets::usockets)
        message(FATAL_ERROR
            "vcpkg's usockets port didn't export the expected target "
            "(unofficial::usockets::usockets). Run: vcpkg install usockets "
            "and make sure CMAKE_TOOLCHAIN_FILE points at vcpkg.cmake.")
    endif()
    add_library(uSockets ALIAS unofficial::usockets::usockets)
    set(UWS_SYSTEM_INSTALL TRUE)
    message(STATUS "Using vcpkg-provided usockets (unofficial::usockets::usockets)")
else()
    set(USOCKETS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/uWebSockets/uSockets")

    if(EXISTS "${USOCKETS_DIR}/src/libusockets.h")
        message(STATUS "Found local uSockets at: ${USOCKETS_DIR}")

        set(USOCKETS_INCLUDE_DIR "${USOCKETS_DIR}/src")

        if(EXISTS "${USOCKETS_DIR}/uSockets.a")
            set(USOCKETS_LIBRARY "${USOCKETS_DIR}/uSockets.a")
            message(STATUS "Found uSockets library: ${USOCKETS_LIBRARY}")
        else()
            message(FATAL_ERROR "uSockets library not built. Please build it: cd ${USOCKETS_DIR} && make")
        endif()

        add_library(uSockets STATIC IMPORTED)
        set_target_properties(uSockets PROPERTIES
            IMPORTED_LOCATION "${USOCKETS_LIBRARY}"
            INTERFACE_INCLUDE_DIRECTORIES "${USOCKETS_INCLUDE_DIR}"
        )
        set(UWS_SYSTEM_INSTALL TRUE)

    else()
        message(FATAL_ERROR
            "Local uSockets not found at ${USOCKETS_DIR}. "
            "Please clone with submodules: git clone --recurse-submodules --depth 1 --branch v20.67.0 https://github.com/uNetworking/uWebSockets.git deps/uWebSockets"
        )
    endif()
endif()

# ── zlib (required by uWebSockets for permessage-deflate) ────────────
# On Linux/macOS zlib usually sneaks in as a transitive dep, but MSVC is
# strict — nothing is linked implicitly, so we must be explicit on Windows.
if(WIN32)
    find_package(ZLIB REQUIRED)
    message(STATUS "Found zlib: ${ZLIB_LIBRARIES}")
endif()

# ── OpenSSL (TLS support) ────────────────────────────────────────────
find_package(OpenSSL QUIET)

if(NOT OpenSSL_FOUND)
    find_path(OPENSSL_INCLUDE_DIR NAMES openssl/ssl.h)
    find_library(OPENSSL_SSL_LIBRARY NAMES ssl)
    find_library(OPENSSL_CRYPTO_LIBRARY NAMES crypto)

    if(OPENSSL_INCLUDE_DIR AND OPENSSL_SSL_LIBRARY AND OPENSSL_CRYPTO_LIBRARY)
        set(OPENSSL_FOUND TRUE)
        set(OPENSSL_LIBRARIES ${OPENSSL_SSL_LIBRARY} ${OPENSSL_CRYPTO_LIBRARY})
    endif()
endif()

if(OPENSSL_FOUND)
    message(STATUS "Found OpenSSL: ${OPENSSL_INCLUDE_DIR}")
else()
    message(WARNING "OpenSSL not found — TLS support will be disabled")
endif()

# ── libuv (required by uSockets) ─────────────────────────────────────
# NOTE: find_package(LibUV) is unreliable across platforms — on macOS,
# Homebrew's libuv CMake config creates the LibUV::LibUV target but omits
# IMPORTED_LOCATION, which silently produces LibUV::LibUV-NOTFOUND at link
# time. We always resolve the library path ourselves and force it onto
# whatever target exists (or create one), rather than trusting a found
# package config to have configured itself correctly.
find_package(LibUV QUIET)

find_path(LIBUV_INCLUDE_DIR NAMES uv.h)
find_library(LIBUV_LIBRARY NAMES uv libuv)

if(NOT LIBUV_INCLUDE_DIR OR NOT LIBUV_LIBRARY)
    message(FATAL_ERROR
        "libuv not found. Install it with your system package manager "
        "(e.g., apt install libuv1-dev, brew install libuv, vcpkg install libuv)")
endif()

message(STATUS "Found libuv: ${LIBUV_LIBRARY}")

if(TARGET LibUV::LibUV)
    set_target_properties(LibUV::LibUV PROPERTIES
        IMPORTED_LOCATION "${LIBUV_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${LIBUV_INCLUDE_DIR}"
    )
else()
    add_library(LibUV::LibUV UNKNOWN IMPORTED)
    set_target_properties(LibUV::LibUV PROPERTIES
        IMPORTED_LOCATION "${LIBUV_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${LIBUV_INCLUDE_DIR}"
    )
endif()

# ── Build shared library ──────────────────────────────────────────────
add_library(cppws_native SHARED ${SOURCES})

target_include_directories(cppws_native PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/cpp
    ${USOCKETS_INCLUDE_DIR}
    ${UWS_INCLUDE_DIR}
    ${CMAKE_JS_INC}
)

target_link_libraries(cppws_native PRIVATE node-addon-api)
target_link_libraries(cppws_native PRIVATE uSockets)
target_link_libraries(cppws_native PRIVATE LibUV::LibUV)

if(OPENSSL_FOUND)
    target_link_libraries(cppws_native PRIVATE ${OPENSSL_LIBRARIES})
    target_include_directories(cppws_native PRIVATE ${OPENSSL_INCLUDE_DIR})
    target_compile_definitions(cppws_native PRIVATE CPPWS_TLS_ENABLED=1)
endif()

if(WIN32)
    # node.lib: resolves napi_call_threadsafe_function / napi_release_threadsafe_function
    # (link-time required on MSVC, unlike Linux/macOS runtime symbol resolution)
    target_link_libraries(cppws_native PRIVATE ${CMAKE_JS_LIB})
    # oldnames.lib: aliases POSIX names (unlink, chmod, ...) to their MSVC
    # underscore-prefixed CRT equivalents (_unlink, _chmod, ...)
    target_link_libraries(cppws_native PRIVATE oldnames)
    # zlib: needed for uWS permessage-deflate (inflate*/deflate* symbols)
    target_link_libraries(cppws_native PRIVATE ZLIB::ZLIB)
    # Winsock + CryptoAPI: pulled in transitively on Linux/macOS but
    # must be explicit with MSVC
    target_link_libraries(cppws_native PRIVATE ws2_32 crypt32)
    # Tell uSockets to use libuv as its event loop backend (suppresses
    # the Unix-domain-socket POSIX code that emits __imp__unlink /
    # __imp__chmod on Windows)
    target_compile_definitions(cppws_native PRIVATE LIBUS_USE_LIBUV=1)
endif()

if(UNIX AND NOT APPLE)
    target_link_libraries(cppws_native PRIVATE pthread dl)
elseif(APPLE)
    find_library(PTHREAD_LIBRARY pthread)
    if(PTHREAD_LIBRARY)
        target_link_libraries(cppws_native PRIVATE ${PTHREAD_LIBRARY})
    endif()
endif()

if(MSVC)
    target_compile_options(cppws_native PRIVATE /W4)
else()
    target_compile_options(cppws_native PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter)
endif()

set_target_properties(cppws_native PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN ON
)