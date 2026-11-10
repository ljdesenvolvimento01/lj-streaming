
"use strict";

const listaUsuarios = document.getElementById("users-list");
const formulario = document.getElementById("create-user-form");
const mensagem = document.getElementById("admin-message");

let usuarios = [];

// ==========================================
// REQUISIÇÕES
// ==========================================

async function requisicao(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        credentials: "same-origin",
        headers: {
            ...(options.body
                ? { "Content-Type": "application/json" }
                : {}),
            ...options.headers
        }
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
        window.location.replace("/login.html");
        throw new Error("Sua sessão expirou.");
    }

    if (response.status === 403) {
        throw new Error("Você não tem permissão para esta operação.");
    }

    if (!response.ok) {
        throw new Error(data.erro || "Erro na operação.");
    }

    return data;
}

// ==========================================
// MENSAGENS
// ==========================================

function mostrarMensagem(texto, tipo = "") {
    mensagem.textContent = texto;
    mensagem.className = "auth-message " + tipo;
}

// ==========================================
// VERIFICAR ADMINISTRADOR
// ==========================================

async function verificarAdministrador() {
    const data = await requisicao("/api/auth/me");

    if (!data.user || data.user.role !== "admin") {
        window.location.replace("/");
        return false;
    }

    document.getElementById("admin-name").textContent =
        data.user.username;

    return true;
}

// ==========================================
// CARREGAR USUÁRIOS
// ==========================================

async function carregarUsuarios() {
    listaUsuarios.innerHTML = `
        <tr>
            <td colspan="5">Carregando usuários...</td>
        </tr>
    `;

    try {
        const data = await requisicao("/api/admin/users");

        usuarios = Array.isArray(data) ? data : [];

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

// ==========================================
// ESTATÍSTICAS
// ==========================================

function atualizarEstatisticas() {
    const ativos = usuarios.filter(user => user.active).length;

    const bloqueados = usuarios.filter(
        user => !user.active
    ).length;

    document.getElementById("total-users").textContent =
        usuarios.length;

    document.getElementById("active-users").textContent =
        ativos;

    document.getElementById("blocked-users").textContent =
        bloqueados;
}

// ==========================================
// RENDERIZAR TABELA
// ==========================================

function renderizarUsuarios() {
    listaUsuarios.replaceChildren();

    if (usuarios.length === 0) {
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
        nome.textContent = usuario.username;

        const tipo = document.createElement("td");
        tipo.textContent =
            usuario.role === "admin" ? "Administrador" : "Usuário";

        const status = document.createElement("td");
        const badge = document.createElement("span");

        badge.className = usuario.active
            ? "status-badge status-active"
            : "status-badge status-blocked";

        badge.textContent = usuario.active
            ? "Ativo"
            : "Bloqueado";

        status.appendChild(badge);

        const cadastro = document.createElement("td");

        cadastro.textContent = usuario.createdAt
            ? new Date(usuario.createdAt).toLocaleDateString("pt-BR")
            : "-";

        const acoes = document.createElement("td");

        if (usuario.role !== "admin") {
            const botaoStatus = document.createElement("button");

            botaoStatus.className = "table-action";
            botaoStatus.textContent = usuario.active
                ? "Bloquear"
                : "Desbloquear";

            botaoStatus.addEventListener("click", () => {
                alterarStatus(usuario);
            });

            const botaoExcluir = document.createElement("button");

            botaoExcluir.className = "table-action danger";
            botaoExcluir.textContent = "Excluir";

            botaoExcluir.addEventListener("click", () => {
                excluirUsuario(usuario);
            });

            acoes.append(botaoStatus, botaoExcluir);

        } else {
            acoes.textContent = "Conta principal";
        }

        tr.append(
            nome,
            tipo,
            status,
            cadastro,
            acoes
        );

        listaUsuarios.appendChild(tr);
    });
}

// ==========================================
// CADASTRAR USUÁRIO
// ==========================================

formulario.addEventListener("submit", async event => {
    event.preventDefault();

    const username = document
        .getElementById("new-username")
        .value.trim();

    const password = document
        .getElementById("new-password")
        .value;

    const botao = document.getElementById("create-button");

    botao.disabled = true;
    botao.textContent = "CADASTRANDO...";

    try {
        await requisicao("/api/admin/users", {
            method: "POST",
            body: JSON.stringify({
                username,
                password
            })
        });

        mostrarMensagem(
            "Usuário cadastrado com sucesso!",
            "success"
        );

        formulario.reset();

        await carregarUsuarios();

    } catch (error) {
        mostrarMensagem(error.message, "error");

    } finally {
        botao.disabled = false;
        botao.textContent = "+ Cadastrar usuário";
    }
});

// ==========================================
// BLOQUEAR E DESBLOQUEAR
// ==========================================

async function alterarStatus(usuario) {
    const novoStatus = !usuario.active;

    const confirmacao = confirm(
        novoStatus
            ? `Desbloquear o usuário ${usuario.username}?`
            : `Bloquear o usuário ${usuario.username}?`
    );

    if (!confirmacao) return;

    try {
        await requisicao(
            `/api/admin/users/${encodeURIComponent(usuario.id)}`,
            {
                method: "PATCH",
                body: JSON.stringify({
                    active: novoStatus
                })
            }
        );

        mostrarMensagem(
            novoStatus
                ? "Usuário desbloqueado."
                : "Usuário bloqueado.",
            "success"
        );

        await carregarUsuarios();

    } catch (error) {
        mostrarMensagem(error.message, "error");
    }
}

// ==========================================
// EXCLUIR USUÁRIO
// ==========================================

async function excluirUsuario(usuario) {
    const confirmacao = confirm(
        `Tem certeza que deseja excluir ${usuario.username}?`
    );

    if (!confirmacao) return;

    try {
        await requisicao(
            `/api/admin/users/${encodeURIComponent(usuario.id)}`,
            {
                method: "DELETE"
            }
        );

        mostrarMensagem(
            "Usuário excluído com sucesso.",
            "success"
        );

        await carregarUsuarios();

    } catch (error) {
        mostrarMensagem(error.message, "error");
    }
}

// ==========================================
// ATUALIZAR LISTA
// ==========================================

document.getElementById("refresh-users")
    .addEventListener("click", carregarUsuarios);

// ==========================================
// SAIR
// ==========================================

document.getElementById("logout-button")
    .addEventListener("click", async () => {
        try {
            await requisicao("/api/auth/logout", {
                method: "POST"
            });

            window.location.replace("/login.html");

        } catch (error) {
            mostrarMensagem(error.message, "error");
        }
    });

// ==========================================
// INICIALIZAR PAINEL
// ==========================================

async function iniciarPainel() {
    try {
        const autorizado = await verificarAdministrador();

        if (autorizado) {
            await carregarUsuarios();
        }

    } catch (error) {
        console.error(error);

        if (!error.message.includes("Sessão expirou")) {
            mostrarMensagem(error.message, "error");
        }
    }
}

iniciarPainel();
