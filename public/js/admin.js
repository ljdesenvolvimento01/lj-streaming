"use strict";

const listaUsuarios = document.getElementById("users-list");
const formulario = document.getElementById("create-user-form");
const mensagem = document.getElementById("admin-message");

async function requisicao(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        credentials: "same-origin",
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers
        }
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
        window.location.replace("/login.html");
        throw new Error("Sua sessão expirou.");
    }
    if (response.status === 403) {
        throw new Error(data.erro || "Você não tem permissão para esta operação.");
    }
    if (!response.ok) {
        throw new Error(data.erro || data.error || `Erro na operação (HTTP ${response.status}).`);
    }
    return data;
}

function mostrarMensagem(texto, tipo = "") {
    mensagem.textContent = texto;
    mensagem.className = "auth-message " + tipo;
}

async function verificarAdministrador() {
    const data = await requisicao("/api/auth/me");
    if (!data.user || data.user.role !== "admin") {
        window.location.replace("/");
        return false;
    }
    document.getElementById("admin-name").textContent = data.user.username;
    return true;
}

let usuarios = [];

async function carregarUsuarios() {
    listaUsuarios.innerHTML = "<tr><td colspan=\"5\">Carregando usuários...</td></tr>";
    try {
        const data = await requisicao("/api/admin/users");
        usuarios = Array.isArray(data) ? data : (Array.isArray(data.users) ? data.users : []);
        atualizarEstatisticas();
        renderizarUsuarios();
    } catch (error) {
        listaUsuarios.innerHTML = "";
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.textContent = error.message;
        tr.appendChild(td);
        listaUsuarios.appendChild(tr);
    }
}

function atualizarEstatisticas() {
    const ativos = usuarios.filter(user => user.active).length;
    document.getElementById("total-users").textContent = usuarios.length;
    document.getElementById("active-users").textContent = ativos;
    document.getElementById("blocked-users").textContent = usuarios.length - ativos;
}

function renderizarUsuarios() {
    listaUsuarios.replaceChildren();
    if (!usuarios.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.textContent = "Nenhum usuário cadastrado.";
        tr.appendChild(td);
        listaUsuarios.appendChild(tr);
        return;
    }

    usuarios.forEach(usuario => {
        const tr = document.createElement("tr");
        const nome = document.createElement("td");
        nome.textContent = usuario.username || "-";

        const tipo = document.createElement("td");
        tipo.textContent = usuario.role === "admin" ? "Administrador" : "Usuário";

        const status = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = usuario.active ? "status-badge status-active" : "status-badge status-blocked";
        badge.textContent = usuario.active ? "Ativo" : "Bloqueado";
        status.appendChild(badge);

        const cadastro = document.createElement("td");
        cadastro.textContent = usuario.createdAt
            ? new Date(usuario.createdAt).toLocaleDateString("pt-BR")
            : "-";

        const acoes = document.createElement("td");
        if (usuario.role !== "admin") {
            const botaoStatus = document.createElement("button");
            botaoStatus.className = "table-action";
            botaoStatus.textContent = usuario.active ? "Bloquear" : "Desbloquear";
            botaoStatus.addEventListener("click", () => alterarStatus(usuario));

            const botaoExcluir = document.createElement("button");
            botaoExcluir.className = "table-action danger";
            botaoExcluir.textContent = "Excluir";
            botaoExcluir.addEventListener("click", () => excluirUsuario(usuario));
            acoes.append(botaoStatus, botaoExcluir);
        } else {
            acoes.textContent = "Conta principal";
        }
        tr.append(nome, tipo, status, cadastro, acoes);
        listaUsuarios.appendChild(tr);
    });
}

formulario.addEventListener("submit", async event => {
    event.preventDefault();
    const username = document.getElementById("new-username").value.trim();
    const password = document.getElementById("new-password").value;
    const botao = document.getElementById("create-button");

    botao.disabled = true;
    botao.textContent = "CADASTRANDO...";
    try {
        await requisicao("/api/admin/users", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });
        mostrarMensagem("Usuário cadastrado com sucesso!", "success");
        formulario.reset();
        await carregarUsuarios();
    } catch (error) {
        mostrarMensagem(error.message, "error");
    } finally {
        botao.disabled = false;
        botao.textContent = "+ Cadastrar usuário";
    }
});

async function alterarStatus(usuario) {
    const novoStatus = !usuario.active;
    if (!confirm(novoStatus ? `Desbloquear ${usuario.username}?` : `Bloquear ${usuario.username}?`)) return;
    try {
        await requisicao(`/api/admin/users/${encodeURIComponent(usuario.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ active: novoStatus })
        });
        mostrarMensagem(novoStatus ? "Usuário desbloqueado." : "Usuário bloqueado.", "success");
        await carregarUsuarios();
    } catch (error) {
        mostrarMensagem(error.message, "error");
    }
}

async function excluirUsuario(usuario) {
    if (!confirm(`Tem certeza que deseja excluir ${usuario.username}?`)) return;
    try {
        await requisicao(`/api/admin/users/${encodeURIComponent(usuario.id)}`, { method: "DELETE" });
        mostrarMensagem("Usuário excluído com sucesso.", "success");
        await carregarUsuarios();
    } catch (error) {
        mostrarMensagem(error.message, "error");
    }
}

document.getElementById("refresh-users").addEventListener("click", carregarUsuarios);

document.getElementById("logout-button").addEventListener("click", async () => {
    try {
        await requisicao("/api/auth/logout", { method: "POST" });
        window.location.replace("/login.html");
    } catch (error) {
        mostrarMensagem(error.message, "error");
    }
});

/* =====================================================
   GERENCIAMENTO DO CATÁLOGO: TV AO VIVO / FILMES / SÉRIES
   API do backend: GET /api/admin/catalog/:type
   API do backend: PATCH /api/admin/catalog/:type/:id
===================================================== */

const catalogoLista = document.getElementById("catalog-list");
const catalogoMensagem = document.getElementById("catalog-message");
const buscaCatalogo = document.getElementById("catalog-search");
const botoesCatalogo = [...document.querySelectorAll("[data-catalog-type]")];

let tipoCatalogoAtual = "live";
let itensCatalogo = [];

function informarCatalogo(texto, erro = false) {
    catalogoMensagem.textContent = texto;
    catalogoMensagem.style.color = erro ? "#fca5a5" : "";
}

function extrairItensCatalogo(data) {
    if (Array.isArray(data)) return data;
    const possiveis = [
        data?.items, data?.itens, data?.results, data?.data,
        data?.catalog, data?.content, data?.streams,
        data?.live, data?.movies, data?.series
    ];
    for (const valor of possiveis) {
        if (Array.isArray(valor)) return valor;
        if (valor && typeof valor === "object") {
            for (const chave of ["items", "itens", "results", "streams"]) {
                if (Array.isArray(valor[chave])) return valor[chave];
            }
        }
    }
    return [];
}
 function idDoConteudo(item) {
    let valor;

    if (tipoCatalogoAtual === "movies") {
        valor = item.stream_id ?? item.vod_id ?? item.movie_id ?? item.id ?? item.num;
    } else if (tipoCatalogoAtual === "series") {
        valor = item.series_id ?? item.id ?? item.num;
    } else {
        valor = item.stream_id ?? item.id ?? item.num;
    }

    return valor === undefined || valor === null ? "" : String(valor);
}



function nomeDoConteudo(item) {
    return item.name || item.title || item.stream_name ||
        item.series_name || item.movie_name || item.original_name ||
        `Conteúdo ${idDoConteudo(item) || "sem nome"}`;
}

function acessoDoConteudo(item) {
    const acesso = String(item.access || item.acesso || "premium").toLowerCase();
    return acesso === "free" || acesso === "gratis" || acesso === "grátis"
        ? "free" : "premium";
}

function criarCartaoCatalogo(item) {
    const id = idDoConteudo(item);
    const acesso = acessoDoConteudo(item);

    const cartao = document.createElement("article");
    cartao.className = "catalog-item";

    const titulo = document.createElement("div");
    titulo.className = "catalog-item-title";
    titulo.textContent = nomeDoConteudo(item);

    const meta = document.createElement("div");
    meta.className = "catalog-item-meta";
    meta.textContent = `ID: ${id || "não identificado"}`;

    const rodape = document.createElement("div");
    rodape.className = "catalog-item-bottom";

    const selo = document.createElement("span");
    selo.className = `access-pill ${acesso === "free" ? "access-free" : "access-premium"}`;
    selo.textContent = acesso === "free" ? "GRÁTIS" : "PREMIUM";

    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "catalog-toggle";
    botao.textContent = acesso === "free" ? "Tornar Premium" : "Liberar grátis";
    botao.disabled = !id;
    if (!id) botao.title = "O conteúdo não possui um ID reconhecido pelo painel.";

    botao.addEventListener("click", () => alterarAcessoConteudo(item, botao));

    rodape.append(selo, botao);
    cartao.append(titulo, meta, rodape);
    return cartao;
}

function renderizarCatalogo() {
    catalogoLista.replaceChildren();
    const termo = buscaCatalogo.value.trim().toLocaleLowerCase("pt-BR");
    const filtrados = itensCatalogo.filter(item =>
        nomeDoConteudo(item).toLocaleLowerCase("pt-BR").includes(termo) ||
        idDoConteudo(item).includes(termo)
    );

    if (!filtrados.length) {
        informarCatalogo(itensCatalogo.length
            ? "Nenhum conteúdo encontrado para essa busca."
            : "Nenhum conteúdo foi retornado pela API.");
        return;
    }

    informarCatalogo(`${filtrados.length} conteúdo(s) encontrado(s).`);
    const fragmento = document.createDocumentFragment();
    filtrados.forEach(item => fragmento.appendChild(criarCartaoCatalogo(item)));
    catalogoLista.appendChild(fragmento);
}

async function carregarCatalogo() {
    catalogoLista.replaceChildren();
    informarCatalogo("Carregando catálogo...");
    try {
        const data = await requisicao(`/api/admin/catalog/${encodeURIComponent(tipoCatalogoAtual)}`);
        itensCatalogo = extrairItensCatalogo(data);
        renderizarCatalogo();
    } catch (error) {
        itensCatalogo = [];
        informarCatalogo(
            `${error.message} Confira se a rota /api/admin/catalog/${tipoCatalogoAtual} está disponível no backend.`,
            true
        );
    }
}

async function alterarAcessoConteudo(item, botao) {
    const id = idDoConteudo(item);
    if (!id) {
        informarCatalogo("Não foi possível identificar o ID deste conteúdo.", true);
        return;
    }

    const acessoAtual = acessoDoConteudo(item);
    const novoAcesso = acessoAtual === "free" ? "premium" : "free";
    const nome = nomeDoConteudo(item);
    const confirmacao = novoAcesso === "free"
        ? `Liberar "${nome}" gratuitamente para todos os usuários?`
        : `Voltar a exigir Premium para "${nome}"?`;
    if (!confirm(confirmacao)) return;

    botao.disabled = true;
    botao.textContent = "Salvando...";
    try {
        const resultado = await requisicao(
            `/api/admin/catalog/${encodeURIComponent(tipoCatalogoAtual)}/${encodeURIComponent(id)}`,
            {
                method: "PATCH",
                body: JSON.stringify({ access: novoAcesso })
            }
        );

        item.access = resultado.access || novoAcesso;
        informarCatalogo(
            novoAcesso === "free"
                ? `"${nome}" agora está GRÁTIS.`
                : `"${nome}" agora é PREMIUM.`
        );
        renderizarCatalogo();
    } catch (error) {
        botao.disabled = false;
        botao.textContent = acessoAtual === "free" ? "Tornar Premium" : "Liberar grátis";
        informarCatalogo(error.message, true);
    }
}

botoesCatalogo.forEach(botao => {
    botao.addEventListener("click", () => {
        tipoCatalogoAtual = botao.dataset.catalogType;
        botoesCatalogo.forEach(item => item.classList.toggle("active", item === botao));
        carregarCatalogo();
    });
});

buscaCatalogo.addEventListener("input", renderizarCatalogo);
document.getElementById("refresh-catalog").addEventListener("click", carregarCatalogo);

async function iniciarPainel() {
    try {
        const autorizado = await verificarAdministrador();
        if (autorizado) {
            await Promise.all([carregarUsuarios(), carregarCatalogo()]);
        }
    } catch (error) {
        console.error(error);
        if (!error.message.includes("Sessão expirou")) mostrarMensagem(error.message, "error");
    }
}

iniciarPainel();
