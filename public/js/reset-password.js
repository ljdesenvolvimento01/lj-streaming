
const form = document.getElementById("resetForm");
const mensagem = document.getElementById("mensagem");

form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value.trim();
    const codigo = document.getElementById("codigo").value.trim();
    const senha = document.getElementById("senha").value;
    const confirmarSenha = document.getElementById("confirmarSenha").value;

    // Validar tamanho da senha
    if (senha.length < 8 || senha.length > 128) {
        mensagem.textContent = "A nova senha deve ter de 8 a 128 caracteres.";
        return;
    }

    // Confirmar senha
    if (senha !== confirmarSenha) {
        mensagem.textContent = "As senhas não são iguais.";
        return;
    }

    // Validar código
    if (!/^\d{6}$/.test(codigo)) {
        mensagem.textContent = "Informe o código de seis dígitos.";
        return;
    }

    mensagem.textContent = "Atualizando senha...";

    try {
        const resposta = await fetch("/api/auth/reset-password", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: email,
                code: codigo,
                password: senha
            })
        });

        const dados = await resposta.json();

        if (!resposta.ok) {
            throw new Error(
                dados.erro || "Não foi possível redefinir a senha."
            );
        }

        mensagem.textContent =
            dados.mensagem || "Senha alterada com sucesso!";

        form.reset();

        setTimeout(() => {
            window.location.href = "/login.html";
        }, 2000);

    } catch (erro) {
        mensagem.textContent = erro.message;
    }
});
