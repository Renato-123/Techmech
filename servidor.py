#!/usr/bin/env python3
"""
TECHMECH — servidor da loja + banco de dados (SQLite)

Como usar:
    python servidor.py
Depois abra  http://localhost:8000  no navegador.

- Não precisa instalar nada: só Python 3.8 ou mais novo.
- Os pedidos ficam no arquivo  techmech.db  (na mesma pasta). Faça backup dele.
- Senha do painel: variável ADMIN_SENHA (padrão: techmech@2026 — TROQUE).
    Windows (PowerShell):  $env:ADMIN_SENHA="minha senha"; python servidor.py
    Mac/Linux:             ADMIN_SENHA="minha senha" python3 servidor.py
- Porta: variável PORT (padrão 8000).
- Para outras pessoas da rede acessarem: HOST=0.0.0.0 (padrão: só este computador).
"""
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

PASTA = Path(__file__).resolve().parent
BANCO = PASTA / "techmech.db"
HOST = os.environ.get("HOST", "127.0.0.1")
PORTA = int(os.environ.get("PORT", "8000"))
SENHA_PADRAO = "techmech@2026"
SENHA_ADMIN = os.environ.get("ADMIN_SENHA", SENHA_PADRAO)
SENHA_DIGEST = hashlib.sha256(SENHA_ADMIN.encode()).digest()

SESSAO_SEGUNDOS = 8 * 3600
MAX_TENTATIVAS, BLOQUEIO_SEGUNDOS = 5, 30
MAX_PEDIDOS_JANELA, JANELA_SEGUNDOS = 20, 600     # por IP, em pedidos públicos
MAX_CORPO = 1_000_000

EXTENSOES = {".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff", ".woff2"}
STATUS = ("pago", "enviado", "entregue", "cancelado")
PAGAMENTOS = ("pix", "cartao", "boleto")
FRETES = ("retirada", "economico", "expresso")

SESSOES = {}          # token -> expiração
TENTATIVAS = {}       # ip -> [falhas, bloqueado_até]
PEDIDOS_POR_IP = {}   # ip -> [timestamps]


# --------------------------------------------------------------------------
# Banco de dados
# --------------------------------------------------------------------------
@contextmanager
def db():
    con = sqlite3.connect(BANCO, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def criar_tabelas():
    with db() as con:
        con.execute("PRAGMA journal_mode = WAL")
        con.executescript("""
            CREATE TABLE IF NOT EXISTS pedidos (
                numero          TEXT PRIMARY KEY,
                data            TEXT NOT NULL,
                status          TEXT NOT NULL DEFAULT 'pago',
                subtotal        INTEGER NOT NULL,   -- valores em centavos
                cupom           TEXT,
                desc_cupom      INTEGER NOT NULL DEFAULT 0,
                desc_pagamento  INTEGER NOT NULL DEFAULT 0,
                frete           INTEGER NOT NULL DEFAULT 0,
                frete_tipo      TEXT NOT NULL,
                pagamento       TEXT NOT NULL,
                parcelas        INTEGER NOT NULL DEFAULT 1,
                juros           INTEGER NOT NULL DEFAULT 0,
                total           INTEGER NOT NULL,
                demo            INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS itens (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                numero      TEXT NOT NULL REFERENCES pedidos(numero) ON DELETE CASCADE,
                produto_id  TEXT NOT NULL,
                nome        TEXT NOT NULL,
                categoria   TEXT NOT NULL DEFAULT '',
                preco       INTEGER NOT NULL,
                qtd         INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pedidos_data ON pedidos(data);
            CREATE INDEX IF NOT EXISTS idx_itens_numero ON itens(numero);
        """)


def cents(valor):
    return int(round(float(valor) * 100))


def reais(centavos):
    return centavos / 100


def novo_numero():
    return "TM" + "".join(secrets.choice("0123456789") for _ in range(8))


def inserir(con, p):
    """Grava o pedido e os itens. Devolve False se o número já existir."""
    cur = con.execute(
        """INSERT OR IGNORE INTO pedidos
           (numero, data, status, subtotal, cupom, desc_cupom, desc_pagamento, frete,
            frete_tipo, pagamento, parcelas, juros, total, demo)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (p["numero"], p["data"], p["status"], p["subtotal"], p["cupom"], p["desc_cupom"],
         p["desc_pagamento"], p["frete"], p["frete_tipo"], p["pagamento"], p["parcelas"],
         int(p["juros"]), p["total"], int(p["demo"])),
    )
    if cur.rowcount == 0:
        return False
    con.executemany(
        "INSERT INTO itens (numero, produto_id, nome, categoria, preco, qtd) VALUES (?,?,?,?,?,?)",
        [(p["numero"], i["id"], i["nome"], i["categoria"], i["preco"], i["qtd"]) for i in p["itens"]],
    )
    return True


def listar():
    with db() as con:
        pedidos = con.execute("SELECT * FROM pedidos ORDER BY data DESC").fetchall()
        itens = con.execute("SELECT * FROM itens ORDER BY id").fetchall()
    por_pedido = {}
    for i in itens:
        por_pedido.setdefault(i["numero"], []).append({
            "id": i["produto_id"], "nome": i["nome"], "categoria": i["categoria"],
            "preco": reais(i["preco"]), "qtd": i["qtd"],
        })
    return [{
        "numero": p["numero"], "data": p["data"], "status": p["status"],
        "itens": por_pedido.get(p["numero"], []),
        "subtotal": reais(p["subtotal"]), "cupom": p["cupom"],
        "descCupom": reais(p["desc_cupom"]), "descPagamento": reais(p["desc_pagamento"]),
        "frete": reais(p["frete"]), "freteTipo": p["frete_tipo"],
        "pagamento": p["pagamento"], "parcelas": p["parcelas"], "juros": bool(p["juros"]),
        "total": reais(p["total"]), "demo": bool(p["demo"]),
    } for p in pedidos]


# --------------------------------------------------------------------------
# Validação (nunca confie no que vem do navegador)
# --------------------------------------------------------------------------
def numero_entre(v, nome, minimo, maximo):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or not minimo <= v <= maximo:
        raise ValueError(f"{nome} inválido")
    return float(v)


def texto(v, nome, maximo, obrigatorio=True):
    if v is None:
        v = ""
    if not isinstance(v, str) or len(v) > maximo or (obrigatorio and not v.strip()):
        raise ValueError(f"{nome} inválido")
    return v.strip()


def validar_pedido(p, admin=False):
    if not isinstance(p, dict):
        raise ValueError("Pedido inválido")
    brutos = p.get("itens")
    if not isinstance(brutos, list) or not 1 <= len(brutos) <= 50:
        raise ValueError("Itens inválidos")

    itens = []
    for i in brutos:
        if not isinstance(i, dict):
            raise ValueError("Item inválido")
        qtd = numero_entre(i.get("qtd"), "Quantidade", 1, 10)
        if qtd != int(qtd):
            raise ValueError("Quantidade inválida")
        itens.append({
            "id": texto(str(i.get("id", "")), "id do produto", 60),
            "nome": texto(i.get("nome"), "Nome do produto", 200),
            "categoria": texto(i.get("categoria"), "Categoria", 80, False),
            "preco": cents(numero_entre(i.get("preco"), "Preço", 0, 1_000_000)),
            "qtd": int(qtd),
        })

    subtotal = sum(i["preco"] * i["qtd"] for i in itens)
    desc_cupom = cents(numero_entre(p.get("descCupom", 0), "Desconto do cupom", 0, 1_000_000))
    desc_pag = cents(numero_entre(p.get("descPagamento", 0), "Desconto do pagamento", 0, 1_000_000))
    if desc_cupom + desc_pag > subtotal:
        raise ValueError("Descontos maiores que o valor dos produtos")
    frete = cents(numero_entre(p.get("frete", 0), "Frete", 0, 500))
    total = cents(numero_entre(p.get("total"), "Total", 0, 2_000_000))
    if total > int(subtotal * 1.30) + frete + 1:     # margem para juros do parcelamento
        raise ValueError("Total incompatível com os itens")

    pagamento, frete_tipo = p.get("pagamento"), p.get("freteTipo")
    if pagamento not in PAGAMENTOS or frete_tipo not in FRETES:
        raise ValueError("Pagamento ou entrega inválidos")
    parcelas = int(numero_entre(p.get("parcelas", 1), "Parcelas", 1, 12))
    if pagamento != "cartao":
        parcelas = 1

    cupom = texto(p.get("cupom"), "Cupom", 30, False).upper() or None
    numero = p.get("numero")
    if not (isinstance(numero, str) and re.fullmatch(r"TM\d{8}", numero)):
        numero = novo_numero()

    status, data, demo = "pago", datetime.now(timezone.utc), False
    if admin:                                         # importação (dados de exemplo)
        status = p.get("status", "pago")
        if status not in STATUS:
            raise ValueError("Status inválido")
        try:
            data = datetime.fromisoformat(str(p.get("data")).replace("Z", "+00:00"))
            if data.tzinfo is None:
                data = data.replace(tzinfo=timezone.utc)
        except ValueError:
            raise ValueError("Data inválida")
        demo = bool(p.get("demo"))

    return {
        "numero": numero, "data": data.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "status": status, "itens": itens, "subtotal": subtotal, "cupom": cupom,
        "desc_cupom": desc_cupom, "desc_pagamento": desc_pag, "frete": frete,
        "frete_tipo": frete_tipo, "pagamento": pagamento, "parcelas": parcelas,
        "juros": bool(p.get("juros")) and pagamento == "cartao", "total": total, "demo": demo,
    }


# --------------------------------------------------------------------------
# Servidor HTTP
# --------------------------------------------------------------------------
class Erro(Exception):
    def __init__(self, codigo, mensagem):
        self.codigo, self.mensagem = codigo, mensagem


class Handler(BaseHTTPRequestHandler):
    server_version = "Techmech"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

    # ---- respostas
    def responder(self, codigo, corpo=b"", tipo="application/json; charset=utf-8"):
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-store" if tipo.startswith("application/json") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(corpo)

    def json(self, codigo, obj):
        self.responder(codigo, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def ler_json(self):
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho > MAX_CORPO:
            raise Erro(413, "Dados grandes demais")
        if tamanho == 0:
            return {}
        try:
            return json.loads(self.rfile.read(tamanho).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise Erro(400, "JSON inválido")

    # ---- autenticação
    def exigir_admin(self):
        agora = time.time()
        for t in [t for t, ate in SESSOES.items() if ate < agora]:
            SESSOES.pop(t, None)
        cab = self.headers.get("Authorization", "")
        token = cab[7:] if cab.startswith("Bearer ") else ""
        if not token or SESSOES.get(token, 0) < agora:
            raise Erro(401, "Sessão expirada. Entre novamente.")
        return token

    # ---- roteamento
    def tratar(self, metodo):
        try:
            url = urlparse(self.path)
            caminho = unquote(url.path)
            if caminho.startswith("/api/"):
                self.api(metodo, caminho[5:].strip("/").split("/"), parse_qs(url.query))
            elif metodo in ("GET", "HEAD"):
                self.estatico(caminho)
            else:
                raise Erro(405, "Método não permitido")
        except Erro as e:
            self.json(e.codigo, {"erro": e.mensagem})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"ERRO: {e!r}\n")
            self.json(500, {"erro": "Erro interno do servidor"})

    do_GET = do_HEAD = lambda self: self.tratar(self.command)
    do_POST = do_PATCH = do_DELETE = lambda self: self.tratar(self.command)

    def api(self, metodo, partes, consulta):
        ip = self.client_address[0]

        if partes == ["login"] and metodo == "POST":
            agora = time.time()
            falhas, ate = TENTATIVAS.get(ip, [0, 0])
            if agora < ate:
                raise Erro(429, f"Muitas tentativas. Aguarde {int(ate - agora) + 1}s.")
            senha = str(self.ler_json().get("senha", ""))
            if hmac.compare_digest(hashlib.sha256(senha.encode()).digest(), SENHA_DIGEST):
                TENTATIVAS.pop(ip, None)
                token = secrets.token_urlsafe(32)
                SESSOES[token] = agora + SESSAO_SEGUNDOS
                return self.json(200, {"token": token})
            falhas += 1
            TENTATIVAS[ip] = [0, agora + BLOQUEIO_SEGUNDOS] if falhas >= MAX_TENTATIVAS else [falhas, 0]
            time.sleep(0.4)
            raise Erro(401, "Senha incorreta.")

        if partes == ["logout"] and metodo == "POST":
            SESSOES.pop(self.exigir_admin(), None)
            return self.json(200, {"ok": True})

        if partes == ["pedidos"]:
            if metodo == "POST":                      # a loja registra uma compra (público)
                agora = time.time()
                recentes = [t for t in PEDIDOS_POR_IP.get(ip, []) if agora - t < JANELA_SEGUNDOS]
                if len(recentes) >= MAX_PEDIDOS_JANELA:
                    raise Erro(429, "Muitos pedidos em pouco tempo")
                try:
                    pedido = validar_pedido(self.ler_json())
                except ValueError as e:
                    raise Erro(400, str(e))
                with db() as con:
                    for _ in range(5):
                        if inserir(con, pedido):
                            break
                        pedido["numero"] = novo_numero()
                    else:
                        raise Erro(500, "Não foi possível gerar o número do pedido")
                PEDIDOS_POR_IP[ip] = recentes + [agora]
                return self.json(201, {"numero": pedido["numero"]})
            self.exigir_admin()
            if metodo == "GET":
                return self.json(200, listar())
            if metodo == "DELETE":                    # ?demo=1 apaga só os de exemplo
                with db() as con:
                    if consulta.get("demo") == ["1"]:
                        con.execute("DELETE FROM pedidos WHERE demo = 1")
                    else:
                        con.execute("DELETE FROM pedidos")
                return self.json(200, {"ok": True})

        if partes == ["pedidos", "importar"] and metodo == "POST":
            self.exigir_admin()
            lote = self.ler_json()
            if not isinstance(lote, list) or len(lote) > 500:
                raise Erro(400, "Envie uma lista com até 500 pedidos")
            try:
                validos = [validar_pedido(p, admin=True) for p in lote]
            except ValueError as e:
                raise Erro(400, str(e))
            with db() as con:
                gravados = sum(1 for p in validos if inserir(con, p))
            return self.json(201, {"gravados": gravados})

        if len(partes) == 2 and partes[0] == "pedidos" and metodo in ("PATCH", "DELETE"):
            self.exigir_admin()
            numero = partes[1]
            with db() as con:
                if metodo == "PATCH":
                    status = self.ler_json().get("status")
                    if status not in STATUS:
                        raise Erro(400, "Status inválido")
                    cur = con.execute("UPDATE pedidos SET status = ? WHERE numero = ?", (status, numero))
                else:
                    cur = con.execute("DELETE FROM pedidos WHERE numero = ?", (numero,))
            if cur.rowcount == 0:
                raise Erro(404, "Pedido não encontrado")
            return self.json(200, {"ok": True})

        raise Erro(404, "Rota não encontrada")

    def estatico(self, caminho):
        if caminho in ("", "/"):
            caminho = "/index.html"
        alvo = (PASTA / caminho.lstrip("/")).resolve()
        escondido = any(parte.startswith(".") for parte in alvo.relative_to(PASTA).parts) if PASTA in alvo.parents else True
        if escondido or alvo.suffix.lower() not in EXTENSOES or not alvo.is_file():
            raise Erro(404, "Arquivo não encontrado")
        tipo = mimetypes.guess_type(alvo.name)[0] or "application/octet-stream"
        if tipo.startswith("text/") or tipo in ("application/javascript", "image/svg+xml"):
            tipo += "; charset=utf-8"
        self.responder(200, alvo.read_bytes(), tipo)


def main():
    criar_tabelas()
    servidor = ThreadingHTTPServer((HOST, PORTA), Handler)
    print(f"\n  Techmech no ar:  http://localhost:{PORTA}")
    print(f"  Banco de dados:  {BANCO}")
    if SENHA_ADMIN == SENHA_PADRAO:
        print("  ATENÇÃO: usando a senha padrão do painel. Defina ADMIN_SENHA para trocar.")
    print("  Para parar: Ctrl+C\n")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\n  Servidor encerrado.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()