const form = document.getElementById("forgotForm");
const mensagem = document.getElementById("mensagem");

form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value.trim();

    mensagem.textContent = "Enviando solicitação...";

    try {
        const resposta = await fetch("/api/auth/forgot-password", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ email })
        });

        const dados = await resposta.json();

        if (!resposta.ok) {
            throw new Error(dados.erro || dados.message || "Erro ao solicitar recuperação.");
        }

        mensagem.textContent = dados.mensagem || dados.message ||
            "Verifique seu e-mail para obter o código.";

        setTimeout(() => {
            window.location.href = "/reset-password.html";
        }, 2500);

    } catch (erro) {
        mensagem.textContent = erro.message;
    }
});