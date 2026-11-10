
// ======================================================
// LJ STREAMING - SISTEMA DE PAGAMENTOS
// Mercado Pago Checkout API Orders + PIX
// LJ PREMIUM - R$ 10,00 / 30 dias
// ======================================================

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function criarSistemaPagamentos({
    lerUsuarios,
    salvarUsuarios,
    localizarUsuarioSessao,
    dataDir,
    appBaseUrl
}) {
    const router = express.Router();
    const webhookRouter = express.Router();

    const ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
    const WEBHOOK_SECRET = process.env.MERCADOPAGO_WEBHOOK_SECRET;
    const AMBIENTE = (
        process.env.MERCADOPAGO_AMBIENTE || "teste"
    ).toLowerCase();

    const PRECO = 10;
    const PLANO = "LJ PREMIUM";
    const DURACAO_DIAS = 30;
    const JANELA_PIX_MS = 30 * 60 * 1000;

    const paymentsFile = path.join(dataDir, "payments.json");

    // --------------------------------------------------
    // ARQUIVOS
    // --------------------------------------------------

    function lerPagamentos() {
        try {
            if (!fs.existsSync(paymentsFile)) {
                fs.mkdirSync(path.dirname(paymentsFile), {
                    recursive: true
                });

                fs.writeFileSync(paymentsFile, "[]", "utf8");
                return [];
            }

            const conteudo = fs.readFileSync(paymentsFile, "utf8");
            const dados = JSON.parse(conteudo || "[]");

            return Array.isArray(dados) ? dados : [];
        } catch (erro) {
            console.error("Erro ao ler pagamentos:", erro.message);
            return [];
        }
    }

    function salvarPagamentos(pagamentos) {
        const temporario = `${paymentsFile}.tmp`;

        fs.mkdirSync(path.dirname(paymentsFile), {
            recursive: true
        });

        fs.writeFileSync(
            temporario,
            JSON.stringify(pagamentos, null, 2),
            "utf8"
        );

        fs.renameSync(temporario, paymentsFile);
    }

    function localizarPagamento(orderId) {
        const pagamentos = lerPagamentos();

        return pagamentos.find(p =>
            String(p.orderId || p.paymentId) === String(orderId)
        );
    }

    function atualizarPagamento(orderId, alteracoes) {
        const pagamentos = lerPagamentos();

        const indice = pagamentos.findIndex(p =>
            String(p.orderId || p.paymentId) === String(orderId)
        );

        if (indice === -1) {
            return null;
        }

        pagamentos[indice] = {
            ...pagamentos[indice],
            ...alteracoes
        };

        salvarPagamentos(pagamentos);

        return pagamentos[indice];
    }

    // --------------------------------------------------
    // USUÁRIO E ASSINATURA
    // --------------------------------------------------

    async function usuarioAtual(req) {
        return await localizarUsuarioSessao(req);
    }

    function obterDataExpiracao(usuario) {
        return (
            usuario.subscriptionExpiresAt ||
            usuario.subscriptionExpiry ||
            usuario.expiresAt ||
            null
        );
    }

    function assinaturaAtiva(usuario) {
        if (!usuario) return false;

        if (usuario.role === "admin") {
            return true;
        }

        if (usuario.subscriptionStatus !== "active") {
            return false;
        }

        const expiracao = obterDataExpiracao(usuario);

        if (!expiracao) return false;

        return new Date(expiracao).getTime() > Date.now();
    }

    async function verificarAssinatura(req, res, next) {
        try {
            const usuario =
                req.currentUser || await usuarioAtual(req);

            if (!usuario) {
                return res.status(401).json({
                    erro: "Faça login para continuar."
                });
            }

            req.currentUser = usuario;

            if (usuario.role === "admin") {
                return next();
            }

            if (!assinaturaAtiva(usuario)) {
                return res.status(403).json({
                    erro: "Assinatura LJ PREMIUM necessária.",
                    assinaturaAtiva: false,
                    codigo: "ASSINATURA_INATIVA"
                });
            }

            return next();
        } catch (erro) {
            console.error(
                "Erro ao verificar assinatura:",
                erro.message
            );

            return res.status(500).json({
                erro: "Não foi possível verificar sua assinatura."
            });
        }
    }

    // --------------------------------------------------
    // MERCADO PAGO - CONSULTAR ORDER
    // --------------------------------------------------

    async function consultarOrder(orderId) {
        if (!ACCESS_TOKEN) {
            throw new Error(
                "MERCADOPAGO_ACCESS_TOKEN não configurado no .env."
            );
        }

        const resposta = await axios.get(
            `https://api.mercadopago.com/v1/orders/${encodeURIComponent(orderId)}`,
            {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                },
                timeout: 20000
            }
        );

        return resposta.data;
    }

    function obterPagamentoPix(order) {
        const pagamentos =
            order?.transactions?.payments || [];

        return pagamentos.find(p =>
            p?.payment_method?.id === "pix"
        ) || pagamentos[0] || null;
    }

    function normalizarStatus(status) {
        if (status === "processed") return "approved";
        if (status === "action_required") return "pending";

        return status || "pending";
    }

    // --------------------------------------------------
    // ATIVAR ASSINATURA
    // --------------------------------------------------

    async function ativarPlano(order) {
        const orderId = String(order?.id || "");
        const registro = localizarPagamento(orderId);

        if (!registro || registro.activated) {
            return false;
        }

        const pagamento = obterPagamentoPix(order);

        // Só ativa quando o Mercado Pago confirmar o crédito.
        if (order.status !== "processed") {
            return false;
        }

        if (!pagamento || pagamento.status !== "processed") {
            return false;
        }

        // Conferências de segurança.
        if (String(order.id) !== String(registro.orderId)) {
            return false;
        }

        if (
            String(order.external_reference) !==
            String(registro.userId)
        ) {
            console.error("Referência externa não corresponde ao usuário.");
            return false;
        }

        if (Number(order.total_amount) !== PRECO) {
            console.error("Valor da order diferente do esperado.");
            return false;
        }

        if (Number(pagamento.amount) !== PRECO) {
            console.error("Valor do pagamento diferente do esperado.");
            return false;
        }

        if (pagamento.payment_method?.id !== "pix") {
            console.error("O pagamento recebido não é PIX.");
            return false;
        }

        const usuarios = await lerUsuarios();

        const usuario = usuarios.find(u =>
            String(u.id) === String(registro.userId)
        );

        if (!usuario) {
            console.error("Usuário do pagamento não encontrado.");
            return false;
        }

        const agora = new Date();
        const expiracaoAtual = obterDataExpiracao(usuario);

        let inicio = agora;

        if (
            usuario.subscriptionStatus === "active" &&
            expiracaoAtual &&
            new Date(expiracaoAtual).getTime() > agora.getTime()
        ) {
            inicio = new Date(expiracaoAtual);
        }

        const novaExpiracao = new Date(inicio);
        novaExpiracao.setDate(
            novaExpiracao.getDate() + DURACAO_DIAS
        );

        usuario.subscriptionStatus = "active";
        usuario.subscriptionPlan = PLANO;
        usuario.subscriptionExpiresAt =
            novaExpiracao.toISOString();

        await salvarUsuarios(usuarios);

        atualizarPagamento(orderId, {
            status: "approved",
            activated: true,
            approvedAt: new Date().toISOString(),
            expiresAt: novaExpiracao.toISOString(),
            transactionId: pagamento.id || null
        });

        console.log(
            `Assinatura LJ PREMIUM ativada para ${usuario.username || usuario.email}.`
        );

        return true;
    }

    // --------------------------------------------------
    // PROCESSAR / ATUALIZAR ORDER
    // --------------------------------------------------

    async function processarPagamento(orderId) {
        const registro = localizarPagamento(orderId);

        if (!registro) {
            throw new Error("Pedido não encontrado.");
        }

        const order = await consultarOrder(orderId);

        if (order.status === "processed") {
            await ativarPlano(order);
        }

        const status = normalizarStatus(order.status);

        atualizarPagamento(orderId, {
            status,
            mercadoPagoStatus: order.status,
            statusDetail: order.status_detail || null,
            lastCheckedAt: new Date().toISOString()
        });

        return {
            order,
            registro: localizarPagamento(orderId)
        };
    }

    // --------------------------------------------------
    // VALIDAR ASSINATURA DO WEBHOOK
    // --------------------------------------------------

    function validarAssinaturaWebhook(req) {
        if (!WEBHOOK_SECRET) {
            console.error(
                "MERCADOPAGO_WEBHOOK_SECRET não configurado."
            );
            return false;
        }

        const assinatura = req.headers["x-signature"];
        const requestId = req.headers["x-request-id"];

        const dataId =
            req.query["data.id"] ||
            req.body?.data?.id ||
            req.body?.id;

        if (!assinatura || !requestId || !dataId) {
            return false;
        }

        const partes = {};

        assinatura.split(",").forEach(parte => {
            const [chave, valor] = parte.trim().split("=");

            if (chave && valor) {
                partes[chave] = valor;
            }
        });

        if (!partes.ts || !partes.v1) {
            return false;
        }

        const manifest =
            `id:${String(dataId).toLowerCase()};` +
            `request-id:${requestId};` +
            `ts:${partes.ts};`;

        const hash = crypto
            .createHmac("sha256", WEBHOOK_SECRET)
            .update(manifest)
            .digest("hex");

        try {
            const recebido = Buffer.from(partes.v1, "hex");
            const esperado = Buffer.from(hash, "hex");

            if (recebido.length !== esperado.length) {
                return false;
            }

            return crypto.timingSafeEqual(
                recebido,
                esperado
            );
        } catch {
            return false;
        }
    }

    // --------------------------------------------------
    // WEBHOOK - TOPIC ORDERS
    // --------------------------------------------------

    webhookRouter.post("/webhook", async (req, res) => {
        try {
            if (!validarAssinaturaWebhook(req)) {
                return res.status(401).json({
                    erro: "Assinatura do webhook inválida."
                });
            }

            const orderId =
                req.query["data.id"] ||
                req.body?.data?.id ||
                req.body?.id;

            if (!orderId) {
                return res.status(400).json({
                    erro: "Identificação do pedido não recebida."
                });
            }

            await processarPagamento(orderId);

            return res.status(200).json({
                recebido: true
            });
        } catch (erro) {
            console.error(
                "Erro no webhook do Mercado Pago:",
                erro.response?.data || erro.message
            );

            return res.status(200).json({
                recebido: true,
                processamento: "pendente"
            });
        }
    });

    // --------------------------------------------------
    // CRIAR PIX
    // --------------------------------------------------

    router.post("/payments/pix", async (req, res) => {
        try {
            if (!ACCESS_TOKEN) {
                return res.status(500).json({
                    erro: "Access Token do Mercado Pago não configurado."
                });
            }

            const usuario = await usuarioAtual(req);

            if (!usuario) {
                return res.status(401).json({
                    erro: "Faça login para assinar."
                });
            }

            if (usuario.role === "admin") {
                return res.status(400).json({
                    erro: "Administradores não precisam assinar."
                });
            }

            if (assinaturaAtiva(usuario)) {
                return res.status(400).json({
                    erro: "Sua assinatura já está ativa."
                });
            }

            if (!usuario.email) {
                return res.status(400).json({
                    erro: "Sua conta precisa ter um e-mail cadastrado."
                });
            }

            const pagamentos = lerPagamentos();
            const agora = Date.now();

            // Reutiliza PIX pendente ainda válido.
            const pendente = pagamentos.find(p => {
                const criado = new Date(p.createdAt).getTime();

                return (
                    String(p.userId) === String(usuario.id) &&
                    !p.activated &&
                    ["pending", "created", "action_required", "processing"].includes(
                        p.status
                    ) &&
                    p.qrCode &&
                    agora - criado < JANELA_PIX_MS
                );
            });

            if (pendente) {
                return res.json({
                    paymentId: pendente.orderId || pendente.paymentId,
                    qrCode: pendente.qrCode,
                    qrCodeBase64: pendente.qrCodeBase64 || "",
                    ticketUrl: pendente.ticketUrl || "",
                    valor: PRECO,
                    plano: PLANO,
                    duracaoDias: DURACAO_DIAS,
                    status: pendente.status
                });
            }

            const idempotencyKey = crypto.randomUUID();

            // No teste, use o pagador de teste indicado
            // pela documentação oficial do Mercado Pago.
            // Em produção, use o e-mail real do usuário.
            const payer = AMBIENTE === "teste"
                ? {
                    email: "test_payer@example.com",
                    first_name: "APRO"
                }
                : {
                    email: usuario.email
                };

            const payload = {
                type: "online",
                processing_mode: "automatic",
                external_reference: String(usuario.id),
                total_amount: PRECO.toFixed(2),
                payer,
                transactions: {
                    payments: [
                        {
                            amount: PRECO.toFixed(2),
                            payment_method: {
                                id: "pix",
                                type: "bank_transfer"
                            }
                        }
                    ]
                }
            };

            const resposta = await axios.post(
                "https://api.mercadopago.com/v1/orders",
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                        "X-Idempotency-Key": idempotencyKey
                    },
                    timeout: 30000
                }
            );

            const order = resposta.data;
            const pagamento = obterPagamentoPix(order);
            const metodo = pagamento?.payment_method || {};

            if (!order.id) {
                throw new Error(
                    "O Mercado Pago não retornou o ID do pedido."
                );
            }

            const qrCode = metodo.qr_code || "";
            const qrCodeBase64 = metodo.qr_code_base64 || "";
            const ticketUrl = metodo.ticket_url || "";

            const registro = {
                orderId: String(order.id),

                // Mantém compatibilidade com o frontend antigo.
                paymentId: String(order.id),

                transactionId: pagamento?.id || null,
                userId: String(usuario.id),
                amount: PRECO,
                status: normalizarStatus(order.status),
                mercadoPagoStatus: order.status || null,
                statusDetail: order.status_detail || null,
                qrCode,
                qrCodeBase64,
                ticketUrl,
                createdAt: new Date().toISOString(),
                activated: false
            };

            const listaAtualizada = lerPagamentos();
            listaAtualizada.push(registro);
            salvarPagamentos(listaAtualizada);

            // Se já tiver sido processado na criação,
            // tenta ativar imediatamente.
            if (order.status === "processed") {
                await ativarPlano(order);
            }

            return res.json({
                paymentId: String(order.id),
                qrCode,
                qrCodeBase64,
                ticketUrl,
                valor: PRECO,
                plano: PLANO,
                duracaoDias: DURACAO_DIAS,
                status: normalizarStatus(order.status)
            });

        } catch (erro) {
            console.error(
                "Erro ao criar PIX:",
                erro.response?.data || erro.message
            );

            const detalhes = erro.response?.data;

            return res.status(
                erro.response?.status || 500
            ).json({
                erro: "Não foi possível criar o PIX.",
                detalhes: detalhes?.message ||
                    detalhes?.error ||
                    erro.message
            });
        }
    });

    // --------------------------------------------------
    // CONSULTAR STATUS DO PIX
    // --------------------------------------------------

    router.get("/payments/:id/status", async (req, res) => {
        try {
            const usuario = await usuarioAtual(req);

            if (!usuario) {
                return res.status(401).json({
                    erro: "Faça login novamente."
                });
            }

            const orderId = String(req.params.id);
            const registro = localizarPagamento(orderId);

            if (!registro) {
                return res.status(404).json({
                    erro: "Pagamento não encontrado."
                });
            }

            if (
                String(registro.userId) !== String(usuario.id) &&
                usuario.role !== "admin"
            ) {
                return res.status(403).json({
                    erro: "Você não tem acesso a este pagamento."
                });
            }

            const resultado = await processarPagamento(orderId);

            const assinatura =
                assinaturaAtiva(usuario) ||
                registro.activated ||
                assinaturaAtiva(
                    (await lerUsuarios()).find(u =>
                        String(u.id) === String(usuario.id)
                    )
                );

            return res.json({
                paymentId: orderId,
                status: resultado.registro?.status || "pending",
                mercadoPagoStatus: resultado.order.status,
                assinaturaAtiva: Boolean(assinatura)
            });

        } catch (erro) {
            console.error(
                "Erro ao consultar pagamento:",
                erro.response?.data || erro.message
            );

            return res.status(500).json({
                erro: "Não foi possível consultar o pagamento."
            });
        }
    });

    // --------------------------------------------------
    // STATUS DA ASSINATURA DO USUÁRIO
    // --------------------------------------------------

    router.get("/subscription/status", async (req, res) => {
        try {
            const usuario = await usuarioAtual(req);

            if (!usuario) {
                return res.status(401).json({
                    erro: "Faça login para continuar."
                });
            }

            return res.json({
                active: assinaturaAtiva(usuario),
                plano: usuario.subscriptionPlan || PLANO,
                status: usuario.role === "admin"
                    ? "active"
                    : usuario.subscriptionStatus || "inactive",
                expiresAt: obterDataExpiracao(usuario)
            });

        } catch (erro) {
            console.error(
                "Erro ao consultar assinatura:",
                erro.message
            );

            return res.status(500).json({
                erro: "Não foi possível consultar sua assinatura."
            });
        }
    });

    return {
        webhookRouter,
        router,
        verificarAssinatura
    };
}

module.exports = criarSistemaPagamentos;
