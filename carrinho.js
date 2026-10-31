/* ==========================================================================
   TECHMECH — carrinho.js
   Carrinho de compras com: quantidade, remover, cupom de desconto, opções de
   frete, formas de pagamento (Pix / Cartão parcelado / Boleto), resumo do
   pedido e confirmação. Salva no navegador (localStorage).

   COMO USAR NA PÁGINA:
     Carrinho.adicionar({ id, nome, preco, imagem })
   ========================================================================== */

(() => {
    'use strict';

    /* ---------------------------------------------------------------------
       CONFIGURAÇÃO — ajuste aqui as regras da sua loja
       --------------------------------------------------------------------- */
    const CONFIG = {
        chaveStorage: 'techmech-carrinho-v1',
        chaveFila: 'techmech-pedidos-pendentes',   // pedidos que não chegaram ao servidor

        // cupons: código -> percentual de desconto sobre os produtos
        cupons: {
            TECHMECH10: { percentual: 0.10, texto: '10% de desconto' },
            BEMVINDO5:  { percentual: 0.05, texto: '5% de desconto' },
            GAMER15:    { percentual: 0.15, texto: '15% de desconto' },
            VICTHORSUPERGAY: { percentual: 1.00, texto: '67% de desconto' }
        },

        // frete grátis automático acima deste valor (nas opções com frete)
        freteGratisAcima: 5000,

        fretes: {
            retirada:  { nome: 'Retirar na loja',  prazo: 'Pronto em 1 dia útil', preco: 0 },
            economico: { nome: 'Econômico',        prazo: 'Até 7 dias úteis',     preco: 29.90 },
            expresso:  { nome: 'Expresso',         prazo: 'Até 2 dias úteis',     preco: 59.90 }
        },

        pagamentos: {
            pix:    { nome: 'Pix',                desconto: 0.10, detalhe: '10% de desconto à vista' },
            cartao: { nome: 'Cartão de crédito',  desconto: 0,    detalhe: 'Em até 12x' },
            boleto: { nome: 'Boleto bancário',    desconto: 0.05, detalhe: '5% de desconto à vista' }
            
        },

        maxParcelas: 12,
        parcelasSemJuros: 6,
        jurosMensal: 0.0199,       // 1,99% ao mês a partir da 7ª parcela
        parcelaMinima: 50,         // valor mínimo de cada parcela
        maxQtdPorItem: 10
    };

    /* ---------------------------------------------------------------------
       UTILIDADES
       --------------------------------------------------------------------- */
    const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const arredonda = (n) => Math.round(n * 100) / 100;
    const escapa = (t) => String(t).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    /* ---------------------------------------------------------------------
       ESTADO
       --------------------------------------------------------------------- */
    const estadoInicial = () => ({
        itens: [],            // { id, nome, preco, imagem, qtd }
        cupom: null,          // código aplicado
        frete: 'economico',
        pagamento: 'pix',
        parcelas: 1
    });

    let estado = estadoInicial();

    const carregar = () => {
        try {
            const salvo = JSON.parse(localStorage.getItem(CONFIG.chaveStorage));
            if (salvo && Array.isArray(salvo.itens)) {
                estado = { ...estadoInicial(), ...salvo };
            }
        } catch (_) { /* sem storage ou JSON inválido: começa vazio */ }
    };

    const salvar = () => {
        try { localStorage.setItem(CONFIG.chaveStorage, JSON.stringify(estado)); } catch (_) {}
    };

    /* ---------------------------------------------------------------------
       CÁLCULOS
       --------------------------------------------------------------------- */
    const calcular = () => {
        const subtotal = arredonda(estado.itens.reduce((s, i) => s + i.preco * i.qtd, 0));
        const cupom = estado.cupom ? CONFIG.cupons[estado.cupom] : null;
        const descCupom = cupom ? arredonda(subtotal * cupom.percentual) : 0;
        const base = subtotal - descCupom;

        const pag = CONFIG.pagamentos[estado.pagamento];
        const descPagamento = arredonda(base * pag.desconto);

        const fr = CONFIG.fretes[estado.frete];
        const freteGratis = fr.preco > 0 && subtotal >= CONFIG.freteGratisAcima;
        const frete = freteGratis ? 0 : fr.preco;

        const total = arredonda(base - descPagamento + frete);

        // parcelamento (só vale para cartão)
        const opcoesParcelas = [];
        for (let n = 1; n <= CONFIG.maxParcelas; n++) {
            let valorParcela, totalFinal, juros;
            if (n <= CONFIG.parcelasSemJuros) {
                valorParcela = total / n;
                totalFinal = total;
                juros = false;
            } else {
                const i = CONFIG.jurosMensal;
                valorParcela = total * i / (1 - Math.pow(1 + i, -n));
                totalFinal = valorParcela * n;
                juros = true;
            }
            if (n > 1 && valorParcela < CONFIG.parcelaMinima) break;
            opcoesParcelas.push({ n, valorParcela: arredonda(valorParcela), totalFinal: arredonda(totalFinal), juros });
        }

        return { subtotal, descCupom, descPagamento, frete, freteGratis, total, opcoesParcelas };
    };

    const qtdTotal = () => estado.itens.reduce((s, i) => s + i.qtd, 0);

    /* ---------------------------------------------------------------------
       CRIAÇÃO DA INTERFACE
       --------------------------------------------------------------------- */
    const iconeCarrinho =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM1 2v2h2l3.6 7.6-1.4 2.4A2 2 0 0 0 7 17h12v-2H7.4l1.1-2h7.5a2 2 0 0 0 1.8-1l3.6-6.5A1 1 0 0 0 20.5 4H5.2l-.9-2H1z"/></svg>';

    const raiz = document.createElement('div');
    raiz.className = 'cart-root';
    raiz.innerHTML = `
        <button class="cart-fab" type="button" aria-label="Abrir carrinho">
            ${iconeCarrinho}
            <span class="cart-count" aria-live="polite">0</span>
        </button>

        <div class="cart-overlay"></div>

        <aside class="cart-drawer" role="dialog" aria-modal="true" aria-label="Carrinho de compras" aria-hidden="true">
            <header class="cart-head">
                <h2>Seu carrinho <small class="cart-head-qtd"></small></h2>
                <button class="cart-close" type="button" aria-label="Fechar carrinho">&times;</button>
            </header>
            <div class="cart-body"></div>
            <footer class="cart-foot"></footer>
        </aside>

        <div class="order-modal" role="dialog" aria-modal="true" aria-hidden="true">
            <div class="order-box"></div>
        </div>

        <div class="cart-toast" role="status" aria-live="polite"></div>
    `;
    document.body.appendChild(raiz);

    const $ = (sel) => raiz.querySelector(sel);
    const fab = $('.cart-fab');
    const contador = $('.cart-count');
    const overlay = $('.cart-overlay');
    const drawer = $('.cart-drawer');
    const corpo = $('.cart-body');
    const rodape = $('.cart-foot');
    const headQtd = $('.cart-head-qtd');
    const modal = $('.order-modal');
    const modalBox = $('.order-box');
    const toast = $('.cart-toast');

    /* ---------------------------------------------------------------------
       RENDERIZAÇÃO
       --------------------------------------------------------------------- */
    const htmlItens = () => estado.itens.map((i) => `
        <li class="cart-item" data-id="${escapa(i.id)}">
            <div class="cart-item-img"><img src="${escapa(i.imagem)}" alt="" loading="lazy"></div>
            <div class="cart-item-info">
                <strong class="cart-item-nome">${escapa(i.nome)}</strong>
                <span class="cart-item-preco">${brl(i.preco)}</span>
                <div class="cart-qty" role="group" aria-label="Quantidade">
                    <button type="button" data-acao="menos" aria-label="Diminuir quantidade">−</button>
                    <span>${i.qtd}</span>
                    <button type="button" data-acao="mais" aria-label="Aumentar quantidade" ${i.qtd >= CONFIG.maxQtdPorItem ? 'disabled' : ''}>+</button>
                </div>
            </div>
            <div class="cart-item-lado">
                <span class="cart-item-sub">${brl(i.preco * i.qtd)}</span>
                <button type="button" class="cart-remove" data-acao="remover" aria-label="Remover ${escapa(i.nome)}">Remover</button>
            </div>
        </li>`).join('');

    const htmlCupom = () => {
        const cupom = estado.cupom ? CONFIG.cupons[estado.cupom] : null;
        return `
        <section class="cart-sec">
            <h3>Cupom de desconto</h3>
            ${cupom ? `
                <div class="cart-cupom-ok">
                    <span><b>${escapa(estado.cupom)}</b> · ${escapa(cupom.texto)}</span>
                    <button type="button" data-acao="tirar-cupom">Remover</button>
                </div>` : `
                <div class="cart-cupom">
                    <input type="text" class="cart-cupom-input" placeholder="Digite seu cupom" maxlength="20" autocomplete="off" aria-label="Código do cupom">
                    <button type="button" data-acao="aplicar-cupom">Aplicar</button>
                </div>
                <p class="cart-dica">Teste: TECHMECH10</p>`}
        </section>`;
    };

    const htmlFrete = (c) => `
        <section class="cart-sec">
            <h3>Opções de entrega</h3>
            <div class="cart-opcoes">
                ${Object.entries(CONFIG.fretes).map(([chave, f]) => {
                    const gratis = f.preco === 0 || (f.preco > 0 && c.subtotal >= CONFIG.freteGratisAcima);
                    return `
                    <label class="cart-opcao ${estado.frete === chave ? 'ativa' : ''}">
                        <input type="radio" name="frete" value="${chave}" ${estado.frete === chave ? 'checked' : ''}>
                        <span class="cart-opcao-txt">
                            <b>${f.nome}</b>
                            <small>${f.prazo}</small>
                        </span>
                        <span class="cart-opcao-preco ${gratis ? 'gratis' : ''}">${gratis ? 'Grátis' : brl(f.preco)}</span>
                    </label>`;
                }).join('')}
            </div>
        </section>`;

    const htmlPagamento = (c) => `
        <section class="cart-sec">
            <h3>Forma de pagamento</h3>
            <div class="cart-opcoes">
                ${Object.entries(CONFIG.pagamentos).map(([chave, p]) => `
                    <label class="cart-opcao ${estado.pagamento === chave ? 'ativa' : ''}">
                        <input type="radio" name="pagamento" value="${chave}" ${estado.pagamento === chave ? 'checked' : ''}>
                        <span class="cart-opcao-txt">
                            <b>${p.nome}</b>
                            <small>${p.detalhe}</small>
                        </span>
                        ${p.desconto ? `<span class="cart-tag">-${Math.round(p.desconto * 100)}%</span>` : ''}
                    </label>`).join('')}
            </div>

            ${estado.pagamento === 'cartao' ? `
            <label class="cart-parcelas">
                <span>Parcelamento</span>
                <select name="parcelas" aria-label="Número de parcelas">
                    ${c.opcoesParcelas.map((o) => `
                        <option value="${o.n}" ${estado.parcelas === o.n ? 'selected' : ''}>
                            ${o.n}x de ${brl(o.valorParcela)} ${o.juros ? `(total ${brl(o.totalFinal)} c/ juros)` : 'sem juros'}
                        </option>`).join('')}
                </select>
            </label>` : ''}
        </section>`;

    const htmlResumo = (c) => {
        const linhas = [
            ['Produtos', brl(c.subtotal)],
            c.descCupom ? ['Cupom', `− ${brl(c.descCupom)}`, 'desc'] : null,
            c.descPagamento ? [`Desconto ${CONFIG.pagamentos[estado.pagamento].nome}`, `− ${brl(c.descPagamento)}`, 'desc'] : null,
            ['Frete', c.frete === 0 ? 'Grátis' : brl(c.frete), c.frete === 0 ? 'desc' : '']
        ].filter(Boolean);

        let aviso = '';
        if (estado.pagamento === 'cartao') {
            const o = c.opcoesParcelas.find((x) => x.n === estado.parcelas) || c.opcoesParcelas[0];
            aviso = `<p class="cart-parcela-info">${o.n}x de <b>${brl(o.valorParcela)}</b>${o.juros ? ` · total ${brl(o.totalFinal)}` : ' sem juros'}</p>`;
        }

        return `
        <dl class="cart-resumo">
            ${linhas.map(([k, v, cls]) => `<div class="${cls || ''}"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
        </dl>
        <div class="cart-total">
            <span>Total</span>
            <strong>${brl(estado.pagamento === 'cartao' ? (c.opcoesParcelas.find((x) => x.n === estado.parcelas) || c.opcoesParcelas[0]).totalFinal : c.total)}</strong>
        </div>
        ${aviso}
        <button type="button" class="cart-finalizar" data-acao="finalizar">Finalizar compra</button>
        <button type="button" class="cart-limpar" data-acao="limpar">Esvaziar carrinho</button>`;
    };

    const render = () => {
        // garante que as parcelas escolhidas ainda existam
        const c = calcular();
        if (!c.opcoesParcelas.some((o) => o.n === estado.parcelas)) estado.parcelas = 1;

        const q = qtdTotal();
        contador.textContent = q;
        contador.classList.toggle('visivel', q > 0);
        headQtd.textContent = q ? `(${q} ${q === 1 ? 'item' : 'itens'})` : '';
        salvar();

        if (!estado.itens.length) {
            corpo.innerHTML = `
                <div class="cart-vazio">
                    <div class="cart-vazio-icone">${iconeCarrinho}</div>
                    <h3>Seu carrinho está vazio</h3>
                    <p>Adicione produtos para ver as opções de entrega e pagamento.</p>
                    <button type="button" class="cart-continuar" data-acao="fechar">Continuar comprando</button>
                </div>`;
            rodape.innerHTML = '';
            rodape.hidden = true;
            return;
        }

        rodape.hidden = false;
        const cupomInput = corpo.querySelector('.cart-cupom-input');
        const textoCupom = cupomInput ? cupomInput.value : '';
        const scroll = corpo.scrollTop;

        corpo.innerHTML = `
            <ul class="cart-lista">${htmlItens()}</ul>
            ${htmlCupom()}
            ${htmlFrete(c)}
            ${htmlPagamento(c)}`;
        rodape.innerHTML = htmlResumo(c);

        const novoInput = corpo.querySelector('.cart-cupom-input');
        if (novoInput && textoCupom) novoInput.value = textoCupom;
        corpo.scrollTop = scroll;

        salvar();
    };

    /* ---------------------------------------------------------------------
       AÇÕES
       --------------------------------------------------------------------- */
    let timerToast;
    const aviso = (msg, tipo = '') => {
        toast.textContent = msg;
        toast.className = `cart-toast mostrar ${tipo}`;
        clearTimeout(timerToast);
        timerToast = setTimeout(() => { toast.className = 'cart-toast'; }, 2400);
    };

    let ultimoFoco = null;
    const abrir = () => {
        ultimoFoco = document.activeElement;
        raiz.classList.add('aberto');
        drawer.setAttribute('aria-hidden', 'false');
        document.documentElement.classList.add('cart-lock');
        setTimeout(() => drawer.querySelector('button, input, select')?.focus(), 250);
    };
    const fechar = () => {
        raiz.classList.remove('aberto');
        drawer.setAttribute('aria-hidden', 'true');
        document.documentElement.classList.remove('cart-lock');
        if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
    };

    const adicionar = (produto, { abrirCarrinho = false } = {}) => {
        const existente = estado.itens.find((i) => i.id === produto.id);
        if (existente) {
            if (existente.qtd >= CONFIG.maxQtdPorItem) {
                aviso(`Máximo de ${CONFIG.maxQtdPorItem} unidades por item`, 'erro');
                return;
            }
            existente.qtd++;
        } else {
            estado.itens.push({
                id: produto.id,
                nome: produto.nome,
                preco: Number(produto.preco),
                imagem: produto.imagem,
                categoria: produto.categoria || '',
                qtd: 1
            });
        }
        render();
        fab.classList.remove('pulo');
        void fab.offsetWidth;               // reinicia a animação
        fab.classList.add('pulo');
        aviso(`${produto.nome} adicionado ao carrinho`);
        if (abrirCarrinho) abrir();
    };

    const mudarQtd = (id, delta) => {
        const item = estado.itens.find((i) => i.id === id);
        if (!item) return;
        item.qtd = Math.min(CONFIG.maxQtdPorItem, item.qtd + delta);
        if (item.qtd <= 0) estado.itens = estado.itens.filter((i) => i.id !== id);
        render();
    };

    const remover = (id) => {
        estado.itens = estado.itens.filter((i) => i.id !== id);
        render();
    };

    const aplicarCupom = () => {
        const input = corpo.querySelector('.cart-cupom-input');
        const codigo = (input?.value || '').trim().toUpperCase();
        if (!codigo) return aviso('Digite um cupom', 'erro');
        if (!CONFIG.cupons[codigo]) {
            input.classList.add('erro');
            setTimeout(() => input.classList.remove('erro'), 600);
            return aviso('Cupom inválido', 'erro');
        }
        estado.cupom = codigo;
        render();
        aviso(`Cupom ${codigo} aplicado!`, 'ok');
    };

    const limpar = () => {
        estado = { ...estadoInicial(), frete: estado.frete, pagamento: estado.pagamento };
        render();
    };

    // envia o pedido ao servidor (banco de dados). Se o servidor estiver fora do ar,
    // guarda numa fila no navegador e tenta de novo na próxima visita.
    const enviarPedido = async (pedido) => {
        const r = await fetch('/api/pedidos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pedido),
            keepalive: true
        });
        if (r.status >= 500 || r.status === 429) throw new Error('servidor indisponível');
        // 2xx: gravado. 4xx: pedido recusado por ser inválido, repetir não adianta.
    };

    const lerFila = () => { try { return JSON.parse(localStorage.getItem(CONFIG.chaveFila)) || []; } catch (_) { return []; } };
    const gravarFila = (f) => { try { localStorage.setItem(CONFIG.chaveFila, JSON.stringify(f)); } catch (_) {} };

    const registrarPedido = (pedido) => {
        enviarPedido(pedido).catch(() => gravarFila(lerFila().concat(pedido)));
    };

    const reenviarPendentes = async () => {
        const fila = lerFila();
        if (!fila.length) return;
        const restantes = [];
        for (const p of fila) {
            try { await enviarPedido(p); } catch (_) { restantes.push(p); }
        }
        gravarFila(restantes);
    };

    const finalizar = () => {
        if (!estado.itens.length) return;
        const c = calcular();
        const pag = CONFIG.pagamentos[estado.pagamento];
        const fr = CONFIG.fretes[estado.frete];
        const op = c.opcoesParcelas.find((o) => o.n === estado.parcelas) || c.opcoesParcelas[0];
        const totalPago = estado.pagamento === 'cartao' ? op.totalFinal : c.total;
        const numero = 'TM' + Date.now().toString().slice(-8);

        registrarPedido({
            numero,
            data: new Date().toISOString(),
            status: 'pago',
            itens: estado.itens.map((i) => ({ id: i.id, nome: i.nome, preco: i.preco, qtd: i.qtd, categoria: i.categoria || '' })),
            subtotal: c.subtotal,
            cupom: estado.cupom,
            descCupom: c.descCupom,
            descPagamento: c.descPagamento,
            frete: c.frete,
            freteTipo: estado.frete,
            pagamento: estado.pagamento,
            parcelas: estado.pagamento === 'cartao' ? op.n : 1,
            juros: estado.pagamento === 'cartao' ? op.juros : false,
            total: totalPago
        });

        const itensHtml = estado.itens.map((i) =>
            `<li><span>${i.qtd}× ${escapa(i.nome)}</span><b>${brl(i.preco * i.qtd)}</b></li>`).join('');

        const textoPagamento = estado.pagamento === 'cartao'
            ? `Cartão de crédito · ${op.n}x de ${brl(op.valorParcela)}${op.juros ? ' (com juros)' : ' sem juros'}`
            : `${pag.nome}${pag.desconto ? ` (${Math.round(pag.desconto * 100)}% off)` : ''}`;

        modalBox.innerHTML = `
            <div class="order-check"><svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M14 27l8 8 16-17"/></svg></div>
            <h2>Pedido realizado!</h2>
            <p class="order-num">Nº do pedido <b>${numero}</b></p>
            <ul class="order-itens">${itensHtml}</ul>
            <dl class="order-det">
                <div><dt>Entrega</dt><dd>${fr.nome} · ${fr.prazo}</dd></div>
                <div><dt>Pagamento</dt><dd>${escapa(textoPagamento)}</dd></div>
                ${c.descCupom ? `<div><dt>Cupom</dt><dd>${escapa(estado.cupom)} (− ${brl(c.descCupom)})</dd></div>` : ''}
                <div><dt>Frete</dt><dd>${c.frete === 0 ? 'Grátis' : brl(c.frete)}</dd></div>
            </dl>
            <div class="order-total"><span>Total</span><strong>${brl(totalPago)}</strong></div>
            <button type="button" class="cart-finalizar" data-acao="fechar-pedido">Voltar à loja</button>
        `;

        limpar();
        fechar();
        modal.classList.add('aberto');
        modal.setAttribute('aria-hidden', 'false');
        document.documentElement.classList.add('cart-lock');
        modalBox.querySelector('button')?.focus();
    };

    const fecharPedido = () => {
        modal.classList.remove('aberto');
        modal.setAttribute('aria-hidden', 'true');
        document.documentElement.classList.remove('cart-lock');
    };

    /* ---------------------------------------------------------------------
       EVENTOS
       --------------------------------------------------------------------- */
    fab.addEventListener('click', abrir);
    overlay.addEventListener('click', fechar);
    $('.cart-close').addEventListener('click', fechar);

    raiz.addEventListener('click', (e) => {
        const alvo = e.target.closest('[data-acao]');
        if (!alvo) return;
        const id = alvo.closest('.cart-item')?.dataset.id;

        switch (alvo.dataset.acao) {
            case 'mais':          mudarQtd(id, +1); break;
            case 'menos':         mudarQtd(id, -1); break;
            case 'remover':       remover(id); break;
            case 'aplicar-cupom': aplicarCupom(); break;
            case 'tirar-cupom':   estado.cupom = null; render(); break;
            case 'limpar':        limpar(); break;
            case 'finalizar':     finalizar(); break;
            case 'fechar':        fechar(); break;
            case 'fechar-pedido': fecharPedido(); break;
        }
    });

    raiz.addEventListener('change', (e) => {
        const { name, value } = e.target;
        if (name === 'frete') estado.frete = value;
        else if (name === 'pagamento') { estado.pagamento = value; if (value !== 'cartao') estado.parcelas = 1; }
        else if (name === 'parcelas') estado.parcelas = Number(value);
        else return;
        render();
    });

    raiz.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('cart-cupom-input')) {
            e.preventDefault();
            aplicarCupom();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (modal.classList.contains('aberto')) fecharPedido();
        else if (raiz.classList.contains('aberto')) fechar();
    });

    modal.addEventListener('click', (e) => { if (e.target === modal) fecharPedido(); });

    // mantém o carrinho sincronizado se a loja estiver aberta em outra aba
    addEventListener('storage', (e) => {
        if (e.key === CONFIG.chaveStorage) { carregar(); render(); }
    });

    /* ---------------------------------------------------------------------
       INÍCIO
       --------------------------------------------------------------------- */
    carregar();
    render();
    reenviarPendentes();

    window.Carrinho = {
        adicionar,
        abrir,
        fechar,
        limpar,
        get itens() { return estado.itens.map((i) => ({ ...i })); },
        get total() { return calcular().total; }
    };
})();