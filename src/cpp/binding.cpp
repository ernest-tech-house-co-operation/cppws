#include <napi.h>
#include "websocket_core.h"

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
    return elysiacppws::WebSocketServer::Init(env, exports);
}

// Module name must match the cmake target: cppws_native
NODE_API_MODULE(cppws_native, InitAll)