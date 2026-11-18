
"use strict";

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

function criarSistemaPagamentos({
    pool,
    localizarUsuarioSessao,
    appBaseUrl
}) {
    if (!pool || typeof pool.query !== "function") {
        throw new Error("Pool PostgreSQL não foi configurado no sistema de pagamentos.");
    }

    if (typeof localizarUsuarioSessao !== "function") {
        throw new Error("Função localizarUsuarioSessao não foi configurada.");
    }

    const webhookRouter = express.Router();
    const router = express.Router();

    const PRECO = 10;
    const PLANO = "LJ PREMIUM";
    const DURACAO_DIAS = 30;
    const JANELA_PIX_MS = 30 * 60 * 1000;

    const ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
    const WEBHOOK_SECRET = process.env.MERCADOPAGO_WEBHOOK_SECRET;
    const AMBIENTE = (
        process.env.MERCADOPAGO_AMBIENTE || "teste"
    ).toLowerCase();

    const API_MERCADO_PAGO = "https://api.mercadopago.com";

    function mapearPagamento(row) {
        if (!row) return null;

        const dados = row.data || {};

        return {
            ...dados,
            orderId: dados.orderId || row.id,
            paymentId: dados.paymentId || row.id,
            userId: row.user_id || dados.userId,
            status: row.status || dados.status || "pending",
            amount: Number(row.amount ?? dados.amount ?? 0)
        };
    }

    async function localizarPagamento(orderId) {
        const resultado = await pool.query(
            `SELECT *
             FROM payments
             WHERE id = $1
                OR data->>'orderId' = $1
                OR data->>'paymentId' = $1
             LIMIT 1`,
            [String(orderId)]
        );

        return mapearPagamento(resultado.rows[0]);
    }

    async function listarPagamentosUsuario(userId) {
        const resultado = await pool.query(
            `SELECT *
             FROM payments
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [String(userId)]
        );

        return resultado.rows.map(mapearPagamento);
    }

    async function salvarNovoPagamento(registro) {
        await pool.query(
            `INSERT INTO payments (
                id,
                user_id,
                status,
                amount,
                data,
                created_at,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
            ON CONFLICT (id)
            DO UPDATE SET
                status = EXCLUDED.status,
                amount = EXCLUDED.amount,
                data = EXCLUDED.data,
                updated_at = NOW()`,
            [
                String(registro.orderId),
                String(registro.userId),
                registro.status,
                PRECO,
                JSON.stringify(registro)
            ]
        );
    }

    async function atualizarPagamento(orderId, alteracoes) {
        const atual = await localizarPagamento(orderId);

        if (!atual) {
            return null;
        }

        const novoStatus = alteracoes.status || atual.status;

        await pool.query(
            `UPDATE payments
             SET status = $2,
                 data = COALESCE(data, '{}'::jsonb) || $3::jsonb,
                 updated_at = NOW()
             WHERE id = $1
                OR data->>'orderId' = $1
                OR data->>'paymentId' = $1`,
            [
                String(orderId),
                novoStatus,
                JSON.stringify(alteracoes)
            ]
        );

        return localizarPagamento(orderId);
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

        if (usuario.role === "admin" || usuario.role === "administrador") {
            return true;
        }

        const expiracao = obterDataExpiracao(usuario);

        return (
            usuario.subscriptionStatus === "active" &&
            expiracao &&
            new Date(expiracao).getTime() > Date.now()
        );
    }

    async function usuarioAtual(req) {
        if (req.currentUser) {
            return req.currentUser;
        }

        return localizarUsuarioSessao(req);
    }

    async function verificarAssinatura(req, res, next) {
        try {
            const usuario = await usuarioAtual(req);

            if (!usuario) {
                return res.status(401).json({
                    erro: "Faça login para continuar."
                });
            }

            if (assinaturaAtiva(usuario)) {
                req.currentUser = usuario;
                return next();
            }

            return res.status(403).json({
                erro: "Sua assinatura LJ PREMIUM não está ativa."
            });
        } catch (erro) {
            console.error("Erro ao verificar assinatura:", erro.message);

            return res.status(500).json({
                erro: "Não foi possível verificar sua assinatura."
            });
        }
    }

    async function consultarOrder(orderId) {
        if (!ACCESS_TOKEN) {
            throw new Error("Token do Mercado Pago não configurado.");
        }

        const resposta = await axios.get(
            `${API_MERCADO_PAGO}/v1/orders/${encodeURIComponent(orderId)}`,
            {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`
                },
                timeout: 20000
            }
        );

        return resposta.data;
    }

    function obterPagamentoPix(order) {
        const pagamentos = order?.transactions?.payments || [];

        return (
            pagamentos.find(
                item => item.payment_method?.id === "pix"
            ) ||
            pagamentos[0] ||
            null
        );
    }

    function normalizarStatus(status) {
        if (status === "processed") return "approved";
        if (status === "action_required") return "pending";

        return status || "pending";
    }

   
async function ativarPlano(order) {
    const orderId = String(order?.id || "");

    if (!orderId) return false;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const resultadoPagamento = await client.query(
            `SELECT *
             FROM payments
             WHERE id = $1
             FOR UPDATE`,
            [orderId]
        );

        const registro = mapearPagamento(
            resultadoPagamento.rows[0]
        );

        if (
            !registro ||
            registro.createdByCurrentSystem !== true ||
            registro.activated === true
        ) {
            await client.query("ROLLBACK");
            return false;
        }

        const pagamento = obterPagamentoPix(order);

        if (
            order.status !== "processed" ||
            pagamento?.status !== "processed" ||
            String(order.id) !== String(registro.orderId) ||
            String(order.external_reference) !== String(registro.userId) ||
            Number(order.total_amount) !== PRECO ||
            Number(pagamento.amount) !== PRECO ||
            pagamento.payment_method?.id !== "pix"
        ) {
            await client.query("ROLLBACK");
            return false;
        }

        const resultadoUsuario = await client.query(
            `SELECT *
             FROM users
             WHERE id = $1
             FOR UPDATE`,
            [String(registro.userId)]
        );

        const usuario = resultadoUsuario.rows[0];

        if (!usuario) {
            await client.query("ROLLBACK");
            return false;
        }

        const agora = new Date();

        const expiracaoAtual = usuario.subscription_expires_at
            ? new Date(usuario.subscription_expires_at)
            : null;

        const assinaturaAindaAtiva =
            usuario.subscription_status === "active" &&
            expiracaoAtual &&
            expiracaoAtual.getTime() > agora.getTime();

        const inicio = assinaturaAindaAtiva
            ? expiracaoAtual
            : agora;

        const novaExpiracao = new Date(
            inicio.getTime() +
            DURACAO_DIAS * 24 * 60 * 60 * 1000
        );

        const agoraISO = agora.toISOString();
        const expiracaoISO = novaExpiracao.toISOString();

        await client.query(
            `UPDATE users
             SET plan = $2::text,
                 subscription_status = 'active',
                 subscription_expires_at = $3::timestamptz,
                 data = COALESCE(data, '{}'::jsonb)
                     || jsonb_build_object('subscriptionPlan', $2::text),
                 updated_at = NOW()
             WHERE id = $1`,
            [
                String(registro.userId),
                PLANO,
                expiracaoISO
            ]
        );

        const atualizacao = {
            status: "approved",
            activated: true,
            approvedAt: agoraISO,
            expiresAt: expiracaoISO,
            transactionId: pagamento.id || null
        };

        await client.query(
            `UPDATE payments
             SET status = 'approved',
                 data = COALESCE(data, '{}'::jsonb) || $2::jsonb,
                 updated_at = NOW()
             WHERE id = $1`,
            [
                orderId,
                JSON.stringify(atualizacao)
            ]
        );

        await client.query("COMMIT");

        console.log(
            "Assinatura LJ PREMIUM ativada:",
            registro.userId
        );

        return true;

    } catch (erro) {
        await client.query("ROLLBACK");
        throw erro;

    } finally {
        client.release();
    }
}


    async function processarPagamento(orderId) {
        const registro = await localizarPagamento(orderId);

        if (!registro) {
            return null;
        }

        const order = await consultarOrder(orderId);

        let ativado = false;

        if (order.status === "processed") {
            ativado = await ativarPlano(order);
        }

        const pagamento = obterPagamentoPix(order);

        await atualizarPagamento(orderId, {
            status: ativado
                ? "approved"
                : normalizarStatus(order.status),
            mercadoPagoStatus: order.status || null,
            statusDetail: order.status_detail || null,
            lastCheckedAt: new Date().toISOString(),
            ...(pagamento?.id
                ? { transactionId: pagamento.id }
                : {})
        });

        return {
            order,
            registro: await localizarPagamento(orderId),
            ativado
        };
    }

    function validarAssinaturaWebhook(req) {
        if (!WEBHOOK_SECRET) {
            return false;
        }

        const assinatura = req.headers["x-signature"];
        const requestId = req.headers["x-request-id"];

        const dataId =
            req.query["data.id"] ||
            req.body?.data?.id;

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

        const manifesto =
            `id:${String(dataId).toLowerCase()};` +
            `request-id:${requestId};` +
            `ts:${partes.ts};`;

        const esperado = crypto
            .createHmac("sha256", WEBHOOK_SECRET)
            .update(manifesto)
            .digest("hex");

        try {
            const recebidoBuffer = Buffer.from(partes.v1, "hex");
            const esperadoBuffer = Buffer.from(esperado, "hex");

            return (
                recebidoBuffer.length === esperadoBuffer.length &&
                crypto.timingSafeEqual(
                    recebidoBuffer,
                    esperadoBuffer
                )
            );
        } catch {
            return false;
        }
    }

    webhookRouter.post("/webhook", async (req, res) => {
        try {
            if (!validarAssinaturaWebhook(req)) {
                return res.status(401).json({
                    erro: "Assinatura do webhook inválida."
                });
            }

            const orderId =
                req.query["data.id"] ||
                req.body?.data?.id;

            if (!orderId) {
                return res.status(400).json({
                    erro: "Identificador do pagamento ausente."
                });
            }

            await processarPagamento(orderId);

            return res.status(200).json({
                recebido: true
            });
        } catch (erro) {
            console.error(
                "Erro no webhook do Mercado Pago:",
                erro.message
            );

            return res.status(200).json({
                recebido: true,
                status: "pending"
            });
        }
    });

    router.post("/payments/pix", async (req, res) => {
        try {
            if (!ACCESS_TOKEN) {
                return res.status(500).json({
                    erro: "Mercado Pago não configurado."
                });
            }

            const usuario = await usuarioAtual(req);

            if (!usuario) {
                return res.status(401).json({
                    erro: "Faça login para gerar o PIX."
                });
            }

            if (
                usuario.role === "admin" ||
                usuario.role === "administrador"
            ) {
                return res.status(400).json({
                    erro: "Administradores não precisam de assinatura."
                });
            }

            if (assinaturaAtiva(usuario)) {
                return res.status(400).json({
                    erro: "Sua assinatura já está ativa."
                });
            }

            if (!usuario.email) {
                return res.status(400).json({
                    erro: "Cadastre um e-mail antes de gerar o PIX."
                });
            }

            const pagamentos = await listarPagamentosUsuario(
                usuario.id
            );

            const agora = Date.now();

            const pendente = pagamentos.find(registro => {
                const criadoEm = new Date(
                    registro.createdAt || 0
                ).getTime();

                return (
                    registro.createdByCurrentSystem === true &&
                    registro.activated !== true &&
                    ["pending", "action_required", "created"].includes(
                        registro.status
                    ) &&
                    registro.qrCode &&
                    agora - criadoEm < JANELA_PIX_MS
                );
            });

            if (pendente) {
                return res.json({
                    sucesso: true,
                    paymentId: pendente.paymentId,
                    qrCode: pendente.qrCode,
                    qrCodeBase64: pendente.qrCodeBase64,
                    ticketUrl: pendente.ticketUrl,
                    valor: PRECO,
                    plano: PLANO,
                    duracaoDias: DURACAO_DIAS,
                    status: pendente.status,
                    reutilizado: true
                });
            }

            const emailPagador = AMBIENTE === "teste"
                ? "test_payer@example.com"
                : usuario.email;

            const nomePagador = AMBIENTE === "teste"
                ? "APRO"
                : (usuario.username || "Cliente");

            const payload = {
                type: "online",
                processing_mode: "automatic",
                external_reference: String(usuario.id),
                total_amount: PRECO.toFixed(2),
                payer: {
                    email: emailPagador,
                    first_name: nomePagador
                },
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
                `${API_MERCADO_PAGO}/v1/orders`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                        "X-Idempotency-Key": crypto.randomUUID()
                    },
                    timeout: 30000
                }
            );

            const order = resposta.data;
            const pagamento = obterPagamentoPix(order);

            const qrCode =
                pagamento?.payment_method?.qr_code ||
                pagamento?.point_of_interaction?.transaction_data?.qr_code ||
                null;

            const qrCodeBase64 =
                pagamento?.payment_method?.qr_code_base64 ||
                pagamento?.point_of_interaction?.transaction_data?.qr_code_base64 ||
                null;

            const ticketUrl =
                pagamento?.payment_method?.ticket_url ||
                pagamento?.point_of_interaction?.transaction_data?.ticket_url ||
                null;

            if (!order.id) {
                throw new Error("Mercado Pago não retornou o ID do pedido.");
            }

            if (!qrCode && !qrCodeBase64) {
                throw new Error("Mercado Pago não retornou o QR Code PIX.");
            }

            const registro = {
                orderId: String(order.id),
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
                activated: false,
                createdByCurrentSystem: true,
                environment: AMBIENTE
            };

            await salvarNovoPagamento(registro);

            if (order.status === "processed") {
                await ativarPlano(order);
            }

            return res.json({
                sucesso: true,
                paymentId: registro.paymentId,
                qrCode,
                qrCodeBase64,
                ticketUrl,
                valor: PRECO,
                plano: PLANO,
                duracaoDias: DURACAO_DIAS,
                status: registro.status
            });
        } catch (erro) {
            console.error(
                "Erro ao gerar PIX:",
                erro.response?.data || erro.message
            );

            return res.status(500).json({
                erro: "Não foi possível gerar o PIX. Tente novamente."
            });
        }
    });

    router.get("/payments/:id/status", async (req, res) => {
        try {
            const usuario = await usuarioAtual(req);

            if (!usuario) {
                return res.status(401).json({
                    erro: "Faça login para consultar o pagamento."
                });
            }

            const registro = await localizarPagamento(req.params.id);

            if (!registro) {
                return res.status(404).json({
                    erro: "Pagamento não encontrado."
                });
            }

            const administrador =
                usuario.role === "admin" ||
                usuario.role === "administrador";

            if (
                String(registro.userId) !== String(usuario.id) &&
                !administrador
            ) {
                return res.status(403).json({
                    erro: "Você não tem acesso a este pagamento."
                });
            }

            const resultado = await processarPagamento(
                registro.orderId
            );

            const usuarioAtualizado = await localizarUsuarioSessao(req);

            const assinatura =
                assinaturaAtiva(usuarioAtualizado);

            const registroAtualizado =
                await localizarPagamento(registro.orderId);

            return res.json({
                paymentId: registroAtualizado.paymentId,
                status: registroAtualizado.status,
                mercadoPagoStatus:
                    resultado?.order?.status || null,
                assinaturaAtiva: assinatura
            });
        } catch (erro) {
            console.error(
    "Erro ao consultar pagamento:",
    erro.stack || erro.message
);
            return res.status(500).json({
                erro: "Não foi possível consultar o pagamento."
            });
        }
    });

    router.get("/subscription/status", async (req, res) => {
        try {
            const usuario = await usuarioAtual(req);

            if (!usuario) {
                return res.status(401).json({
                    erro: "Faça login para consultar sua assinatura."
                });
            }

            return res.json({
                active: assinaturaAtiva(usuario),
                plan: usuario.subscriptionPlan || usuario.plan || PLANO,
                status:
                    usuario.role === "admin" ||
                    usuario.role === "administrador"
                        ? "active"
                        : usuario.subscriptionStatus || "inactive",
                expiresAt: obterDataExpiracao(usuario)
            });
        } catch (erro) {
            console.error(
                "Erro ao consultar assinatura:",
                erro.stack ||  erro.message
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
