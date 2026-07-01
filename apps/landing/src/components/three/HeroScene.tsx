'use client'

import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useRef, useMemo } from 'react'
import * as THREE from 'three'

// Floating geometric orbs
function FloatingOrbs({ count = 8 }: { count?: number }) {
  const orbs = useMemo(
    () =>
      Array.from({ length: count }, (_, _i) => ({
        position: [
          (Math.random() - 0.5) * 20,
          (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 20 - 10,
        ],
        scale: 0.5 + Math.random() * 1.5,
        speed: 0.2 + Math.random() * 0.4,
        phase: Math.random() * Math.PI * 2,
        color:
          Math.random() > 0.5
            ? new THREE.Color('#0ea5e9') // Primary blue
            : new THREE.Color('#ff6b35'), // Accent orange
      })),
    [count]
  )

  return (
    <group>
      {orbs.map((orb, i) => (
        <FloatingOrb key={i} {...orb} index={i} />
      ))}
    </group>
  )
}

function FloatingOrb({
  position,
  scale,
  speed,
  phase,
  color,
  _index,
}: {
  position: number[]
  scale: number
  speed: number
  phase: number
  color: THREE.Color
  index: number
}) {
  const meshRef = useRef<THREE.Mesh>(null!)

  useFrame((state) => {
    if (!meshRef.current) return
    const t = state.clock.getElapsedTime()
    meshRef.current.position.y = position[1] + Math.sin(t * speed + phase) * 2
    meshRef.current.position.x = position[0] + Math.cos(t * speed * 0.7 + phase) * 1.5
    meshRef.current.rotation.y = t * speed * 0.5
    meshRef.current.rotation.x = t * speed * 0.3
  })

  return (
    <mesh ref={meshRef} position={position} scale={scale}>
      <icosahedronGeometry args={[1, 0]} />
      <meshPhysicalMaterial
        color={color}
        metalness={0.3}
        roughness={0.4}
        transparent
        opacity={0.3}
        transmission={0.3}
        thickness={0.5}
        clearcoat={0.5}
        clearcoatRoughness={0.1}
      />
    </mesh>
  )
}

// Centerpiece - rotating geometric shape
function HeroCenterpiece() {
  const groupRef = useRef<THREE.Group>(null!)
  const innerRef = useRef<THREE.Mesh>(null!)
  const outerRef = useRef<THREE.Mesh>(null!)

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (groupRef.current) groupRef.current.rotation.y = t * 0.1
    if (innerRef.current) innerRef.current.rotation.x = t * 0.3
    if (innerRef.current) innerRef.current.rotation.y = t * 0.2
    if (outerRef.current) outerRef.current.rotation.y = -t * 0.15
    if (outerRef.current) outerRef.current.rotation.x = t * 0.1
  })

  return (
    <group ref={groupRef} position={[0, 0, -2]}>
      {/* Outer ring */}
      <mesh ref={outerRef} scale={2.5}>
        <torusGeometry args={[1, 0.15, 16, 100]} />
        <meshPhysicalMaterial
          color="#0ea5e9"
          metalness={0.8}
          roughness={0.1}
          transparent
          opacity={0.2}
        />
      </mesh>

      {/* Inner geometric shape */}
      <mesh ref={innerRef} scale={1.2}>
        <octahedronGeometry args={[1, 1]} />
        <meshPhysicalMaterial
          color="#0ea5e9"
          metalness={0.5}
          roughness={0.2}
          transparent
          opacity={0.4}
          transmission={0.5}
          thickness={0.5}
        />
      </mesh>

      {/* Core glow */}
      <mesh scale={0.5}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color="#0ea5e9" transparent opacity={0.6} />
      </mesh>
    </group>
  )
}

// Animated grid background
function GridBackground() {
  const gridRef = useRef<THREE.LineSegments>(null!)

  useFrame((state) => {
    if (!gridRef.current) return
    const t = state.clock.getElapsedTime()
    gridRef.current.position.z = (-t * 2) % 10
  })

  return (
    <group>
      <gridHelper args={[100, 100, '#0ea5e9', '#0ea5e9']} />
      {/* Secondary grid lines */}
      <gridHelper args={[100, 100, '#ff6b35', '#ff6b35']} position={[0, -0.1, 0]} />
    </group>
  )
}

// Main Hero Scene Component
export function HeroScene() {
  return (
    <Canvas
      camera={{ position: [0, 2, 8], fov: 50 }}
      gl={{
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      }}
      className="w-full h-full"
    >
      <fog attach="fog" args={['#020617', 5, 25]} />

      {/* Lights */}
      <ambientLight intensity={0.4} color="#ffffff" />
      <directionalLight position={[5, 10, 7]} intensity={2} color="#ffffff" castShadow />
      <pointLight position={[-5, 5, 3]} color="#0ea5e9" intensity={3} distance={20} decay={2} />
      <pointLight position={[5, -5, 3]} color="#ff6b35" intensity={2} distance={20} decay={2} />
      <pointLight position={[0, 8, 5]} color="#ffffff" intensity={1} distance={30} decay={2} />

      {/* Scene Objects */}
      <GridBackground />
      <FloatingOrbs count={12} />
      <HeroCenterpiece />

      {/* Controls */}
      <OrbitControls
        enablePan={false}
        enableZoom={false}
        enableRotate={true}
        autoRotate={true}
        autoRotateSpeed={0.3}
        minPolarAngle={Math.PI / 3}
        maxPolarAngle={Math.PI / 2}
      />
    </Canvas>
  )
}

// Export individual components for composition
export { FloatingOrbs, HeroCenterpiece, GridBackground }
