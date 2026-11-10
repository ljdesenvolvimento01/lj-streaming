
"use strict";

const form = document.getElementById("login-form");
const button = document.getElementById("login-button");
const message = document.getElementById("login-message");

function mostrarMensagem(texto, tipo = "") {
    message.textContent = texto;
    message.className = "auth-message " + tipo;
}

form.addEventListener("submit", async event => {
    event.preventDefault();

    const username = document
        .getElementById("username")
        .value
        .trim();

    const password = document
        .getElementById("password")
        .value;

    if (!username || !password) {
        mostrarMensagem("Preencha usuário e senha.", "error");
        return;
    }

    button.disabled = true;
    button.textContent = "VERIFICANDO...";
    mostrarMensagem("Verificando suas credenciais...");

    try {
        const response = await fetch("/api/auth/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "same-origin",
            body: JSON.stringify({
                username,
                password
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.erro || "Não foi possível entrar."
            );
        }

        mostrarMensagem("Login realizado com sucesso!", "success");

        if (data.user.role === "admin") {
            window.location.replace("/admin.html");
        } else {
            window.location.replace("/");
        }

    } catch (error) {
        mostrarMensagem(error.message, "error");

        button.disabled = false;
        button.textContent = "ENTRAR NA PLATAFORMA";
    }
});
