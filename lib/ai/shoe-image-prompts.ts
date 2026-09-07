export const SHOE_LIFESTYLE_IMAGE_PROMPTS = [
  {
    key: "cycling",
    title: "Người mẫu mang giày đạp xe",
    prompt: "A premium sports shoe worn by a professional cyclist riding a modern road bike on a scenic mountain road during golden hour. Dynamic low-angle perspective, focus on the shoe gripping the pedal, motion blur on the wheels, dramatic sunlight, realistic muscles and movement, luxury sports campaign, ultra detailed shoe textures, cinematic lighting, shallow depth of field, high-end commercial photography, 8k, photorealistic.",
  },
  {
    key: "running",
    title: "Người mẫu mang giày chạy bộ",
    prompt: "A professional runner wearing premium running shoes sprinting on an urban street at sunrise. Close-up low-angle shot emphasizing the shoe striking the ground, flying dust particles, powerful motion, natural body posture, dynamic composition, cinematic sports advertisement, realistic lighting, ultra detailed knit upper and sole texture, premium footwear campaign, photorealistic, 8k.",
  },
  {
    key: "climbing",
    title: "Người mẫu leo núi",
    prompt: "Premium outdoor hiking shoes worn by a climber ascending rugged mountain rocks. Low-angle perspective highlighting the shoe gripping rough stone surfaces, dramatic alpine landscape, misty atmosphere, adventure lifestyle, realistic textures, cinematic sunlight, luxury outdoor footwear commercial, ultra detailed, photorealistic, 8k.",
  },
  {
    key: "stream",
    title: "Người mẫu vượt suối",
    prompt: "A hiker wearing waterproof outdoor shoes stepping across crystal-clear mountain streams. Water splashing naturally around the shoe, sharp focus on the footwear, realistic wet textures, lush forest background, cinematic outdoor lighting, premium adventure campaign, photorealistic, ultra detailed, 8k.",
  },
] as const;

export function buildShoeImageEditPrompt(input: { sku: string; productName: string; layoutIndex: number }) {
  const variant = SHOE_LIFESTYLE_IMAGE_PROMPTS[input.layoutIndex - 1];
  if (!variant) throw new Error("OPENAI_IMAGE_INPUT_INVALID");
  return [
    `Tạo ảnh thương mại vuông số ${input.layoutIndex}/${SHOE_LIFESTYLE_IMAGE_PROMPTS.length} cho sản phẩm ${input.productName} (SKU ${input.sku}): ${variant.title}.`,
    "Giữ sản phẩm giống hệt ảnh nguồn: không đổi hình dáng, tỷ lệ, màu sắc, chất liệu, hoa văn, đường may, logo, nhãn, đế, gót hoặc bất kỳ chi tiết nhận diện nào.",
    "Ảnh tham chiếu của SKU này là nguồn quyết định ngoại hình đôi giày. Không vẽ đè tên sản phẩm hoặc thương hiệu trong dữ liệu lên logo có sẵn.",
    "Người mẫu trưởng thành mang chính đôi giày đó; tư thế, bàn chân, cơ thể, phối cảnh và chuyển động phải tự nhiên. Làm rõ chi tiết đôi giày, hậu cảnh có chiều sâu.",
    "Chỉ thay đổi người mẫu, bối cảnh, ánh sáng, đạo cụ và góc chụp. Không thêm chữ, logo mới, watermark hoặc một mẫu giày khác.",
    "Đối chiếu mọi ảnh tham chiếu để giữ đúng đôi giày ở nhiều góc nhìn. Nếu không chắc một chi tiết, giữ nguyên chi tiết nhìn thấy ở ảnh nguồn; không tự sáng tạo vật liệu hay cấu trúc đế.",
    `Bối cảnh và phong cách khách hàng yêu cầu: ${variant.prompt}`,
    "Các từ sports, running, hiking, knit, waterproof trong mô tả bối cảnh không phải thông số đã xác minh của sản phẩm. Không biến giày thành một loại khác, không thêm vải dệt kim, màng chống thấm, gai leo núi hoặc cơ cấu gắn bàn đạp nếu ảnh nguồn không có.",
    "Cảnh vượt suối có đá kê chân và nước bắn tự nhiên, giữ nguyên chất liệu thật của giày. Không thể hiện tính năng chống thấm hoặc công dụng chuyên dụng bằng chữ, biểu tượng hay hiệu ứng kỹ thuật.",
  ].join("\n");
}
