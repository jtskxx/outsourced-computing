cmake_minimum_required(VERSION 3.21)
project(Sender LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED TRUE)

if(CMAKE_CMAKE_BUILD_TYPE MATCHES DEBUG)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -g")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -g")
endif()

# Additional cmake flags
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang" OR CMAKE_CXX_COMPILER_ID MATCHES "GNU")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -mrdrnd -mbmi")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -mrdrnd -mbmi")
elseif(CMAKE_CXX_COMPILER_ID STREQUAL "MSVC")
else()
    message(FATAL "Unsupported compiler.")
endif()

# Main executable
add_executable(${PROJECT_NAME} src/Sender.cpp src/keyUtils.cpp)

include_directories(${PROJECT_NAME} ./src)

# Linking
if(WIN32)
    target_link_libraries(${PROJECT_NAME} wsock32 ws2_32)
else()
    target_link_libraries(${PROJECT_NAME} pthread)
endif()
