import socket, time, struct, threading, sys, os

def tcp(host, port, label, timeout=4):
    t=time.time()
    try:
        s=socket.create_connection((host,port),timeout=timeout); s.close()
        print(f"TCP  PASS  {label:<38} {host}:{port}  {1000*(time.time()-t):.1f}ms")
        return True
    except Exception as e:
        print(f"TCP  FAIL  {label:<38} {host}:{port}  {type(e).__name__}: {e}")
        return False

print("--- TCP: local services ---")
tcp("127.0.0.1",9003,"Backend HTTP/Socket.IO")
tcp("127.0.0.1",5432,"PostgreSQL")
tcp("127.0.0.1",8002,"Orderflow service (expected closed here)")

print("--- TCP: outbound (egress policy of this sandbox is restricted) ---")
tcp("api.github.com",443,"HTTPS egress (allowlisted in sandbox)")
tcp("api.fyers.in",443,"Fyers REST (not allowlisted here)")
tcp("socket.fyers.in",443,"Fyers WebSocket (not allowlisted here)")

print("--- UDP: loopback echo, 2000 datagrams ---")
srv=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); srv.bind(("127.0.0.1",0)); port=srv.getsockname()[1]; srv.settimeout(0.5)
stop=False
def echo():
    while not stop:
        try:
            d,a=srv.recvfrom(2048); srv.sendto(d,a)
        except socket.timeout: pass
th=threading.Thread(target=echo,daemon=True); th.start()
c=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); c.settimeout(1.0)
ok=0; rtts=[]
for i in range(2000):
    payload=struct.pack("!Id",i,time.time())+b"x"*200
    c.sendto(payload,("127.0.0.1",port))
    try:
        d,_=c.recvfrom(2048)
        if struct.unpack("!Id",d[:12])[0]==i: ok+=1; rtts.append((time.time()-struct.unpack("!Id",d[:12])[1])*1000)
    except socket.timeout: pass
stop=True
rtts.sort()
print(f"UDP  {'PASS' if ok==2000 else 'WARN'}  loopback echo {ok}/2000 delivered, loss={100*(2000-ok)/2000:.2f}%, rtt p50={rtts[len(rtts)//2]:.3f}ms p99={rtts[int(len(rtts)*.99)]:.3f}ms")

print("--- UDP: DNS (port 53) — the only UDP the app actually depends on ---")
def dns_query(server, name="github.com"):
    q=struct.pack("!HHHHHH",0x1234,0x0100,1,0,0,0)+b"".join(bytes([len(p)])+p.encode() for p in name.split("."))+b"\x00"+struct.pack("!HH",1,1)
    s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3); t=time.time()
    try:
        s.sendto(q,(server,53)); d,_=s.recvfrom(512)
        an=struct.unpack("!H",d[6:8])[0]
        print(f"UDP  PASS  DNS via {server:<15} answers={an} {1000*(time.time()-t):.1f}ms"); return True
    except Exception as e:
        print(f"UDP  FAIL  DNS via {server:<15} {type(e).__name__}: {e}"); return False
ns=[l.split()[1] for l in open("/etc/resolv.conf") if l.startswith("nameserver")]
print("resolvers in /etc/resolv.conf:",ns)
for n in ns[:2]: dns_query(n)
dns_query("8.8.8.8"); 

print("--- UDP: NTP (port 123) — clock accuracy matters for candle timestamps ---")
def ntp(server="pool.ntp.org"):
    s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3)
    try:
        t=time.time(); s.sendto(b"\x1b"+47*b"\0",(server,123)); d,_=s.recvfrom(48)
        secs=struct.unpack("!12I",d)[10]-2208988800
        print(f"UDP  PASS  NTP {server} offset={secs-time.time():+.3f}s")
    except Exception as e:
        print(f"UDP  FAIL  NTP {server} {type(e).__name__}: {e}")
ntp()