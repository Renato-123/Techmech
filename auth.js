/* ==========================================================================
   TECHMECH — auth.js
   Login do painel administrativo. A senha é conferida no servidor
   (servidor.py), nunca aqui. Para trocar a senha, veja o topo do servidor.py.
   ========================================================================== */
(() => {
    'use strict';

    const CHAVE = 'techmech-admin-token';
    const ler = () => { try { return sessionStorage.getItem(CHAVE); } catch (_) { return null; } };

    window.Auth = {
        async entrar(senha) {
            try {
                const r = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ senha })
                });
                const d = await r.json().catch(() => null);
                if (r.ok && d && d.token) {
                    sessionStorage.setItem(CHAVE, d.token);
                    return { ok: true };
                }
                if (d && d.erro) return { ok: false, erro: d.erro };
                // resposta que não veio do servidor.py (outro servidor está atendendo este endereço)
                return { ok: false, erro: 'Este endereço não está rodando o servidor.py (erro ' + r.status + '). Feche outros servidores, rode "python servidor.py" e abra http://localhost:8000' };
            } catch (_) {
                return { ok: false, erro: 'Servidor desligado. Rode "python servidor.py" e abra http://localhost:8000' };
            }
        },
        logado: () => !!ler(),
        token: ler,
        sair() {
            const t = ler();
            try { sessionStorage.removeItem(CHAVE); } catch (_) {}
            if (t) fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t }, keepalive: true }).catch(() => {});
        },
        // fetch que já envia o token do administrador
        fetch(url, opc = {}) {
            return fetch(url, {
                ...opc,
                headers: { 'Content-Type': 'application/json', ...(opc.headers || {}), Authorization: 'Bearer ' + (ler() || '') }
            });
        }
    };
})();