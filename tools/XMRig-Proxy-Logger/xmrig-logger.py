#!/usr/bin/env python3
import socket
import json
import threading
import time
import sys
import os
from datetime import datetime

# Configuration settings - edit these as needed
LISTEN_HOST = '0.0.0.0'  # Listen on all interfaces
LISTEN_PORT = 8888       # Local port where XMRig will connect
POOL_HOST = 'xmr.pool'  # Target mining pool
POOL_PORT = 3333         # Target pool port

# ANSI colors for better console readability
BLUE = '\033[94m'
GREEN = '\033[92m'
YELLOW = '\033[93m'
RED = '\033[91m'
ENDC = '\033[0m'
BOLD = '\033[1m'

def get_timestamp():
    """Return current timestamp in readable format"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

def print_divider(char='-', length=80):
    """Print a divider line to the console"""
    print(YELLOW + char * length + ENDC)

def format_json(data):
    """Format JSON data for pretty printing"""
    try:
        # Try to parse as JSON
        json_data = json.loads(data)
        # Format with indentation
        return json.dumps(json_data, indent=2)
    except:
        # Return as is if not valid JSON
        return data

def hexdump(data, length=16):
    """Create a hexdump of binary data"""
    result = []
    for i in range(0, len(data), length):
        chunk = data[i:i+length]
        hex_str = ' '.join(f'{b:02x}' for b in chunk)
        ascii_str = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
        offset = f'{i:08x}'
        padding = ' ' * (3 * (length - len(chunk)))
        result.append(f"{offset}  {hex_str}{padding}  |{ascii_str}|")
    return '\n'.join(result)

class ProxyServer:
    def __init__(self):
        self.server_socket = None
        self.connections = []
        self.running = False
    
    def start(self):
        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        
        try:
            self.server_socket.bind((LISTEN_HOST, LISTEN_PORT))
            self.server_socket.listen(5)
            self.running = True
            
            print_divider('=')
            print(f"{GREEN}{BOLD}XMRig Console Logger{ENDC}")
            print_divider('=')
            print(f"{BOLD}Listening on:{ENDC} {LISTEN_HOST}:{LISTEN_PORT}")
            print(f"{BOLD}Forwarding to:{ENDC} {POOL_HOST}:{POOL_PORT}")
            print(f"\n{BOLD}Configure XMRig to connect to:{ENDC} 127.0.0.1:{LISTEN_PORT}")
            print_divider('=')
            print(f"{YELLOW}Waiting for XMRig to connect...{ENDC}")
            
            while self.running:
                client_socket, address = self.server_socket.accept()
                print(f"\n{GREEN}[{get_timestamp()}] New XMRig connection from {address[0]}:{address[1]}{ENDC}")
                
                # Start a new thread to handle this connection
                client_handler = threading.Thread(
                    target=self.handle_client,
                    args=(client_socket,)
                )
                client_handler.daemon = True
                client_handler.start()
                self.connections.append(client_handler)
                
        except Exception as e:
            print(f"{RED}Server error: {e}{ENDC}")
        finally:
            self.shutdown()
    
    def handle_client(self, client_socket):
        # Connect to the actual mining pool
        pool_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        
        try:
            pool_socket.connect((POOL_HOST, POOL_PORT))
            print(f"{GREEN}[{get_timestamp()}] Connected to mining pool {POOL_HOST}:{POOL_PORT}{ENDC}")
            
            # Create threads for bidirectional communication
            client_to_pool = threading.Thread(
                target=self.forward_data,
                args=(client_socket, pool_socket, "MINER → POOL", BLUE)
            )
            
            pool_to_client = threading.Thread(
                target=self.forward_data,
                args=(pool_socket, client_socket, "POOL → MINER", GREEN)
            )
            
            client_to_pool.daemon = True
            pool_to_client.daemon = True
            
            client_to_pool.start()
            pool_to_client.start()
            
            # Wait for either thread to finish (connection closed)
            client_to_pool.join()
            pool_to_client.join()
            
        except Exception as e:
            print(f"{RED}Connection error: {e}{ENDC}")
        finally:
            # Clean up
            if client_socket:
                client_socket.close()
            if pool_socket:
                pool_socket.close()
    
    def forward_data(self, source, destination, direction, color):
        try:
            message_counter = 0
            while True:
                # Receive data
                data = source.recv(4096)
                if not data:
                    print(f"{RED}[{get_timestamp()}] {direction} connection closed{ENDC}")
                    break
                
                message_counter += 1
                
                # Print header for this message
                print_divider()
                print(f"{color}{BOLD}[{get_timestamp()}] {direction} (Message #{message_counter}, {len(data)} bytes){ENDC}")
                print_divider()
                
                # Try to decode and format as JSON
                try:
                    decoded = data.decode('utf-8')
                    if '{' in decoded and '}' in decoded:
                        pretty_json = format_json(decoded)
                        print(f"{color}{pretty_json}{ENDC}")
                    else:
                        # Not JSON, print as text
                        print(f"{color}{decoded}{ENDC}")
                except UnicodeDecodeError:
                    # Binary data, show as hex dump
                    print(f"{YELLOW}Binary data detected. Showing hex dump:{ENDC}")
                    print(f"{color}{hexdump(data)}{ENDC}")
                
                # Forward the data to the destination
                destination.sendall(data)
                
                # Add a trailing divider for readability
                print_divider()
                print()  # Empty line for better separation
                
        except Exception as e:
            print(f"{RED}[{get_timestamp()}] Data forwarding error in {direction}: {e}{ENDC}")
    
    def shutdown(self):
        print(f"{YELLOW}Shutting down proxy server...{ENDC}")
        self.running = False
        
        if self.server_socket:
            self.server_socket.close()
        
        for conn in self.connections:
            if conn.is_alive():
                conn.join(1)  # Give threads 1 second to finish

if __name__ == "__main__":
    # Check if port is already in use
    test_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        test_socket.bind((LISTEN_HOST, LISTEN_PORT))
        test_socket.close()
    except socket.error as e:
        print(f"{RED}Error: Port {LISTEN_PORT} is already in use or cannot be bound.{ENDC}")
        print(f"{YELLOW}Try changing the LISTEN_PORT value in the script to another port (e.g., 8888){ENDC}")
        sys.exit(1)
    
    # Try to connect to pool
    try:
        print(f"{YELLOW}Testing connection to pool {POOL_HOST}:{POOL_PORT}...{ENDC}")
        pool_test = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        pool_test.settimeout(5)
        pool_test.connect((POOL_HOST, POOL_PORT))
        pool_test.close()
        print(f"{GREEN}Pool connection test successful!{ENDC}")
    except Exception as e:
        print(f"{RED}Failed to connect to pool {POOL_HOST}:{POOL_PORT}: {e}{ENDC}")
        print(f"{YELLOW}The proxy might not work if it can't reach the pool.{ENDC}")
        user_input = input("Continue anyway? (y/n): ")
        if user_input.lower() != 'y':
            sys.exit(1)
    
    # Start the proxy
    try:
        proxy = ProxyServer()
        proxy.start()
    except KeyboardInterrupt:
        print(f"\n{YELLOW}Proxy stopped by user{ENDC}")
