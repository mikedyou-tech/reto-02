# Reglas de registro de contratos
- **Cotizaciones (`cotizacion`):** se rechazan (`rechazado`) y se envían a alertas.
- **Duplicados o reenvíos (`duplicado`):** si el asunto es un reenvío (`fwd:` / `reenv`) o el número de contrato ya está en el maestro o registrado previamente, se marcan como `duplicado` y se envían a alertas.
- **Confirmación humana (`confirmacion_humana`):** si el remitente no está verificado en `comerciales.json`, faltan datos clave o hay condiciones pendientes de revisión, se detiene el registro automático y se espera aprobación humana.
- **Pólizas en contratos nuevos (`nuevo`):** si el contrato requiere póliza, el estado de póliza es `pendiente`; si no requiere o no aplica, es `no_aplica`.