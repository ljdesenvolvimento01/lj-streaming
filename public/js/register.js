
const form = document.getElementById("registerForm");
const mensagem = document.getElementById("mensagem");

form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const username = document.getElementById("username").value.trim();
    const email = document.getElementById("email").value.trim();
    const senha = document.getElementById("senha").value;
    const confirmarSenha = document.getElementById("confirmarSenha").value;

    if (username.length < 3 || username.length > 32) {
        mensagem.textContent = "O usuário deve ter de 3 a 32 caracteres.";
        return;
    }

    if (senha.length < 8 || senha.length > 128) {
        mensagem.textContent = "A senha deve ter de 8 a 128 caracteres.";
        return;
    }

    if (senha !== confirmarSenha) {
        mensagem.textContent = "As senhas não coincidem.";
        return;
    }

    mensagem.textContent = "Criando sua conta...";

    try {
        const resposta = await fetch("/api/auth/register", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                username: username,
                email: email,
                password: senha,
                confirmPassword: confirmarSenha
            })
        });

        const dados = await resposta.json();

        if (!resposta.ok) {
            throw new Error(
                dados.erro || "Não foi possível criar a conta."
            );
        }

        mensagem.textContent = "Conta criada com sucesso!";

        setTimeout(() => {
            window.location.href = "/login.html";
        }, 1500);

    } catch (erro) {
        mensagem.textContent = erro.message;
    }
});
